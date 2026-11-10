# Overseer mode

This fork of [Mindcraft](https://github.com/mindcraft-bots/mindcraft) can run its agents under
[mindcraft-overseer](https://github.com/woodraskam/mindcraft-overseer), the control plane for a local
Paper 1.21.11 server run by an AI overseer. The overseer hands bots **task briefs** through its task
board and dispatcher. The bots report what they change in the world, read back from their own chunk
view, so the board can check "done" against the world rather than taking a bot's word for it.

Overseer mode is **off by default** (`"overseer": false` in `settings.js`). With it off, nothing under
`src/overseer/` is loaded and the fork behaves exactly like upstream.

All the code is in `src/overseer/`. Upstream files got four small edits, listed under
[Upstream files touched](#upstream-files-touched).

## The seam

The overseer side is the `@mindcraft/bots` package (`bots/` in mindcraft-overseer). Its design is the
section "Mindcraft fork integration (design)" in `bots/README.md`. This fork wires each piece of that
design as follows.

| Design | Here |
|---|---|
| `attachBotClient(agent.bot, { transport, executor })` after spawn | `host.js` `hostAgent`, called by `agent_host.js` once upstream's spawn handling is done (`OverseerAgent.whenReady`) |
| `skillCommands(client)` as `!skill_<name>` | `commands.js`, registered through `registerCommands`, the one function added to `src/agent/commands/index.js` |
| `mindcraftExecutor(agent)` and `agent.runTask(brief, handle)` | `tasks.js` `BriefAgent` (below) |
| `client.reportChangedBlocks` and `client.reportContainer` for raw Mineflayer | `readback.js`, which wraps the bot's world-changing methods once |
| `bots.json` validated by `BotRuntimeConfigSchema` | `config.js` `loadBotsConfig` |
| the driver module the fleet launcher loads (`--driver ./module.js`) | `driver.js` (exports `driver`) |

### One process per bot

The design sketch has the driver create the agent inside the faction process. That doesn't work for
Mindcraft. Its agent is built to own a process:

- **Process-wide singletons.** `settings` (`src/agent/settings.js`), the MindServer proxy, the
  conversation manager, and the mode controller (`modes.js` keeps `_agent`) are all one per process.
- **Exits.** It calls `process.exit()` when the bot is kicked, when the spawn times out, from
  `cleanKill`, and when an action won't stop within 10 s.
- **`lockdown()`.** It freezes JavaScript's intrinsics for the whole process the first time `!newAction`
  runs.

Three agents in one faction process would share all of that, and one kick would take the other two
bots down. So `driver.js` keeps upstream's own model and forks one **agent process** per bot
(`agent_host.js`):

```
fleet launcher ── faction process (overseer's faction-main.js) ── FactionLink ── HTTP ── dispatcher's BotHub
                      │ driver.js
                      ├── agent process Lodge_1 (agent_host.js): Mindcraft agent + BotClient + Mineflayer bot
                      ├── agent process Lodge_2
                      └── agent process Lodge_3          (IPC: init, board, command, close / online, uplink, command_result, ending)
```

- **Where the client lives.** The `BotClient` lives in the agent process, next to the Mineflayer bot it
  wraps.
- **What the faction process does.** It forwards the bot's uplink (observation batches, task messages,
  skill records) to its `FactionLink` unchanged and in order. It passes board messages and commands
  back down.
- **What the faction process holds.** It gets a small proxy for the bot: its epoch and an async
  `handleCommand`. `@mindcraft/bots` now types this as `DrivenClient`.
- **Exits.** Agent processes run at below-normal priority (`os.setPriority`, niceness 10), so the
  Minecraft server's tick thread wins. In an agent process, `process.exit` first releases the held task
  (`interrupted`), reports the disconnect, and tells the driver why. Only then does it exit, so a kicked
  bot is reported by the bot itself and the rest of the faction carries on.
- **What the launcher sees.** The faction process reports that bot `offline`, with the kick reason.

This is the main deviation from the design sketch, and an open decision for you (see
[Open decisions](#open-decisions)). The cost is 12 agent processes plus 4 faction processes instead of
4. Upstream Mindcraft already runs one process per agent.

## How a brief becomes agent work

The `TaskRunner` in `@mindcraft/bots` owns the task protocol: `task_started`, heartbeats, `task_done`
and the completion loop, stuck reports and releases. The model never sends a protocol message, so it
can't forget a heartbeat or claim "done" without the board checking the world. `BriefAgent.runTask`
(`tasks.js`) only decides how the work gets done.

1. **Preempt.** The brief stops whatever the agent was doing on its own. A self-prompted goal
   (`!goal`) is paused and not resumed afterwards: the overseer decides what the bot does next. Any
   running action is stopped.
2. **Plan** (`planBrief`). The agent works out what it must hold when it's done: the brief's `carry`,
   plus everything it must deposit, minus what it withdraws from the task's reservations. The
   shortfall is that minus the current inventory.
3. **No shortfall: decline.** Work the brief spells out block by block (place, clear, withdraw,
   deposit, go to) is per-block work. Per-block work is plain code, so the agent returns `"decline"` and
   the deterministic `BriefExecutor` does it. **No model call.**
4. **Shortfall, or a `custom` task with nothing resolved: model loop.** The agent runs a bounded loop of
   model turns:
   - **First turn.** A goal prompt: the task, what to obtain, the brief's pinned library skills, and how
     to finish.
   - **Each later turn.** A short progress prompt.
   - **Commands.** Each answer's one command runs through upstream's command system: `executeCommand`,
     Mindcraft's actions, and the `!skill_*` commands.
   - **Exit.** The loop ends when the items are in the inventory, when the model sends `!taskDone`, or
     when it sends `!giveUpTask("<code>", "<reason>")`.
   - **Then.** The agent returns `"decline"` too. The deterministic executor does whatever is mechanical
     and makes the final carry check, and the runner claims done.
5. **Problems.** `!giveUpTask` throws a `TaskProblem` with the model's code (`unreachable`,
   `missing_materials`, … or `other`). Running out of turns or time throws `timeout`. The runner releases
   the task with that code, and the dispatcher maps it to release or fail
   (`TASK_PROBLEM_DISPOSITION`).
6. **Cancel.** `task_cancel`, a superseding brief, or shutdown aborts the handle's signal:
   - **Interrupt.** The agent interrupts itself with upstream's `requestInterrupt` (stop digging, the
     pathfinder, collecting, pvp). The override in `OverseerAgent` also aborts the running library skill.
   - **The answer in flight.** A model answer that arrives after the cancel is dropped before its
     command runs. The loop uses its own turn function (`briefTurn`), built from upstream's command
     functions, instead of `Agent.handleMessage`, so it can check in between.
   - **No release.** The board already took the task back.
7. **Progress.** Each command the model runs becomes a `task_progress` note (`mindcraft: !skill_fell_tree`).
   Every skill the model runs during a brief is recorded with `context: { task, attempt }`.

The limits are `mindcraft.brief` in bots.json: `maxTurns` (default 12) and `maxMinutes` (default 10) per
attempt.

### What Mindcraft's own model loop does

**While a brief is held:**
- **Chat and system events start no model turns.** That covers whispers, death notices, and
  conversation timeouts (`OverseerAgent.handleMessage`). The message is added to the history, so the
  agent knows about it afterwards. A whispering player gets a canned "busy" line, at most every 30 s.
- **Only the brief loop prompts the model.**
- **The agent counts as busy** (`isIdle()` is false), so Mindcraft's idle-only modes (item collecting,
  elbow room, idle staring) and action resumption stay out of the way.

**When idle (no brief):**
- **Upstream behaviour:** a whisper starts a normal Mindcraft conversation turn. The model can use
  every allowed command, including `!skill_*`.
- **Open chat is ignored** (the MindServer proxy reports a peer, as upstream does with several
  agents), so a dozen bots don't all call their model on every chat line, including each other's.
- **No model call at spawn** (`init_message` is null).
- **An idle bot with no whispers costs nothing.**

## Switched off under the overseer

These are forced in `config.js`, whatever `settings.js` or `bots.json` say.

| Feature | Why |
|---|---|
| MindServer, its UI, `auto_open_ui` | The overseer is the control plane. The proxy gets a socket that goes nowhere. |
| Mindcraft's task system (`settings.task`, `--task_path`, `checkTaskDone`, `checkAllPlayersPresent`) | Briefs come from the overseer's board. |
| `load_memory` | Bots don't survive a restart. The overseer re-initialises them. |
| `init_message` | No model call at spawn. |
| `!newAction` (`allow_insecure_coding`) **outside a container** | Model-generated code runs only in Docker. It is allowed only when bots.json asks for it *and* `/.dockerenv` (or `/run/.containerenv`) exists. |
| `!startConversation`, `!endConversation` | Bot-to-bot talk rides the MindServer. Coordination goes through the overseer. |
| `!restart` | A bot's process belongs to the fleet launcher. Restarts are the overseer's call (`relogin`). |
| `!setMode` | It would undo the modes below. |
| Modes `torch_placing`, `hunting` | World changes and wandering nobody asked for. Torches also spend inventory the board reserved. |
| Mode `unstuck` | The Warden owns stuck recovery. Mindcraft's version walks a waiting bot off its task, and kills the agent when it fails. |
| Mode `cheat` | It places blocks with `/setblock` chat commands, which are neither audited nor read back. |
| Viewer, vision, speech | They aren't needed. The viewer and vision need native `canvas`/`gl`. |

Everything else stays as upstream has it. That includes chat (`chat_ingame`, which is flavour) and the
survival modes `self_preservation` and `self_defense`. Those modes can interrupt the deterministic
executor mid-brief, for example to fight a zombie. The executor's own retry (`task_stuck`, backoff) picks
the work up again.

## Read-backs (raw Mineflayer)

The rule in `@mindcraft/bots`: a world change made outside its port must be reported, or the world model
never hears of it. Mindcraft changes the world in many ways:
- its library (`src/agent/library/skills.js`);
- its modes;
- the pathfinder's own digging and scaffolding;
- `!newAction` code.

Rather than edit every call site, `readback.js` wraps the bot's world-changing methods once, on the bot
instance:

| Call | Reported |
|---|---|
| `dig(block)` | the block, read back after the dig settles |
| `placeBlock(ref, face)` | `ref + face` |
| `activateBlock(block)` | the block (doors, levers, tilling), now and 300 ms later |
| `activateItem()` holding a bucket, flint and steel, fire charge, or bone meal | the block at the cursor and its six neighbours, now and 300 ms later |
| `openBlock` / `openContainer` | the container, with the contents its window shows when it closes, through `client.reportContainer(pos, window)`. No second open. |

What is reported is always what the chunk view shows afterwards. The port's own actions go through the
same methods, so they're reported twice; identical read-backs merge in the emitter's flush window.

Not covered: block changes made with chat commands (`/setblock`; the bots aren't op'd, and cheat mode is
off), and entities. The bridge's phase-2 feed makes all of this moot once it lands.

## bots.json

`bots.json` sits in the fork's root, or wherever `MINDCRAFT_BOTS_CONFIG` points. Copy
`bots.example.json`, which is the fleet plan: 4 factions × 3 bots.
- **The shared part** (`server`, `cadence`, `bots[].username/viewDistance/role`) is validated by
  `BotRuntimeConfigSchema` from `@mindcraft/bots`.
- **The fork's own keys**:
  - `bots[].profile`: a Mindcraft profile for that bot.
  - `mindcraft.profile`: the profile for the rest. Default: `andy.json`.
  - `mindcraft.settings`: `settings.js` overrides for every agent.
  - `mindcraft.brief`: the limits above.

The fleet launcher has its own config (`FleetConfigSchema`: factions, the dispatcher's URL, the login
stagger). The driver refuses to log a bot in when the two files disagree: when the bot isn't in
bots.json, or when the server host, port, or version differ. Two files naming one fleet must not drift
apart.

Each agent's profile is the profile file, renamed to the bot, with the modes above forced on top. Its
model is the profile's `model`; API keys come from `keys.json` or the environment, as upstream.

## Running it

**Prerequisites:**
- The mindcraft-overseer checkout is built (`npm install && npm run build` there).
- The dispatcher's bot hub is up (`node dispatcher/dist/cli.js serve` there, on `127.0.0.1:7340`).
- The bots are on the server's whitelist.

From this fork:

```bash
npm run overseer:link                       # once; and npm install re-links it (postinstall)
cp bots.example.json bots.json              # then edit profiles/models
node ../mindcraft-overseer/bots/dist/cli.js fleet ../mindcraft-overseer/bots/fleet.example.json --check
node ../mindcraft-overseer/bots/dist/cli.js fleet ../mindcraft-overseer/bots/fleet.example.json --driver src/overseer/driver.js
```

`npm start` with `"overseer": true` in `settings.js` (or `SETTINGS_JSON='{"overseer":{"fleet":"<fleet.json>"}}'`)
does the same through `src/overseer/main.js`. `settings.overseer` may name `fleet` (default
`./fleet.json`, or `OVERSEER_FLEET`) and `bots` (default `./bots.json`).

## The @mindcraft/bots dependency

`@mindcraft/bots` is **not** an npm dependency in `package.json`. It and its workspace siblings
(`@mindcraft/contracts`, `@mindcraft/skills`, …) are not published. A `file:` dependency would make npm
resolve the linked package's own dependencies, `@mindcraft/contracts@*` among them, from the public
registry. Instead, `src/overseer/link.js` links `node_modules/@mindcraft/bots` to `<checkout>/bots`:
- **The link type.** A junction on Windows, a symlink elsewhere.
- **Where the rest resolves.** Node follows the link to its real path and resolves everything else from
  the checkout's own `node_modules`.
- **The same module instance.** The faction process (the overseer's `faction-main.js`) and this fork's
  driver both load the same `bots/dist` files.
- **Where the checkout is.** `npm run overseer:link [<path>]`, or `MINDCRAFT_OVERSEER`. The default is
  `../mindcraft-overseer`: the two repos side by side.
- **Re-linking.** `npm install` prunes the link as extraneous, then `postinstall` puts it back
  (`--if-present`: only if the checkout is there, so an upstream-style install without it still works).
- **Safety.** Neither `npm prune` nor `npm run clean:modules` touches the link's target. Both were
  checked on Windows: only the junction is removed.

**On this Windows PC** (`E:\PersonalSource\mindcraft` next to `E:\PersonalSource\mindcraft-overseer`):
- **Now.** The link points at the overseer worktree that holds the `bots/` changes this wiring needs
  (`MINDCRAFT_OVERSEER=../mindcraft-overseer/.claude/worktrees/fork-seam`, branch `claude/fork-seam`).
- **Once that branch is merged** into the overseer's `main` and built there, `npm run overseer:link`
  with no argument links the main checkout.

**In Docker on the Linux host** (the overseer checkout at `/home/mark/mindcraft-overseer`, built on the host
with `npm ci && npm run build`):
- **The image.** Upstream's `Dockerfile` (Node 22, plus the native deps for `canvas`/`gl`) builds this
  fork as is.
- **The overseer checkout** is mounted read-only, and the link is made at container start:

```yaml
services:
  fleet:
    build: .
    network_mode: host          # the hub (127.0.0.1:7340) and the server (127.0.0.1:25565) listen on the host's localhost
    environment:
      MINDCRAFT_OVERSEER: /mindcraft-overseer
      SETTINGS_JSON: '{"overseer": {"fleet": "/config/fleet.json", "bots": "/config/bots.json"}}'
    volumes:
      - /home/mark/mindcraft-overseer:/mindcraft-overseer:ro
      - ./overseer-config:/config:ro      # fleet.json, bots.json
      - ./keys.json:/app/keys.json:ro     # or pass the API keys as environment variables
      - ./bots:/app/bots                  # agent histories (optional)
    command: sh -c "npm run overseer:link && npm start"
```

- **Dependencies.** The overseer's runtime dependencies are plain JavaScript (`node:sqlite` is built in),
  so the host-installed `node_modules` works inside the container. Keep the host's and the image's Node
  major versions the same (22).
- **Codegen.** Inside the container `/.dockerenv` exists, so `!newAction` is allowed if bots.json asks
  for it (`mindcraft.settings.allow_insecure_coding: true`).

## Upstream files touched

| File | Change |
|---|---|
| `src/agent/commands/index.js` | `registerCommands(commands)`: add or replace commands defined elsewhere (10 lines) |
| `settings.js` | `"overseer": false` (1 line) |
| `main.js` | hand off to `src/overseer/main.js` when `settings.overseer` is set (4 lines) |
| `package.json` | scripts `overseer:link` and `test:overseer`; `postinstall` re-links (`--if-present`) |

New files: `src/overseer/**`, `bots.example.json`, this file. Everything else, including the other
behaviour changes, is a subclass or an override in `src/overseer/`:
- `OverseerAgent extends Agent`;
- example loading deferred until after login, so the login happens in the launcher's slot;
- `process.exit` handled in the agent process.

## Tests

```bash
npm run test:overseer
```

The tests use Node's built-in runner, so they add no new dependency. They run offline: no Minecraft
server, no model API, no `keys.json`.
- **The simulated side.** `sim.js`: `SimBot` from `@mindcraft/bots` with a teleporting pathfinder, so
  the real `attachBotClient` and `PathfinderNavigator` run unchanged.
- **The model.** A scripted prompter.
- **The service side.** The real dispatcher, bot hub, task board, and world state, imported from the
  linked overseer checkout and listening on an ephemeral localhost port.

They cover:
- **`config.test.js`.** bots.json validation and agreement, the forced settings and modes, and skill
  schema flattening.
- **`host.test.js`** (one process, the real agent object and command system):
  - a brief declined to the deterministic executor with no model call;
  - a brief worked by the model with a library skill;
  - a cancel mid-turn, with the late command never run;
  - `!giveUpTask` released with its code;
  - turn exhaustion released as `timeout`;
  - `!skill_*` from the model and from a player;
  - a whisper during a brief;
  - read-backs of raw `placeBlock`/`dig`/chest use.
- **`driver.test.js`** (real processes and sockets):
  - a faction runtime with this driver, an agent process per bot: brief done on the board, a Warden-style
    command answered, refusals, a clean stop;
  - a kicked bot reporting its own disconnect while the faction carries on;
  - the fleet launcher forking a real faction process with **three bots**: staggered logins, a brief
    done, a clean stop.

`--sim` can rehearse the same thing by hand: the driver option `sim: true | { give, replies, kickAfterMs }`
(programmatic `driverOptions`; the CLI passes none).

## Not verified yet

- **Nothing here has met a live server or a real model.** The real-agent path (`Agent.start()`,
  `whenReady`, the deferred example loading, the `viewDistance` setting on login) has only run as far as
  the module imports. The read-back wrappers are tested on the simulated bot, not on real Mineflayer
  windows.
- **The mineflayer patch.** `patches/mineflayer+4.33.0.patch` (upstream's) doesn't apply to the
  mineflayer that installs today (4.39.0, the version the overseer pinned and smoke-tested on 1.21.11),
  and `patch-package` reports the error. The patch shortens `placeBlock`'s wait for the block update
  (5 s → 0.5 s) and changes the dig-time and use-item rotation maths. Unpatched 4.39.0 waits for the
  update, which suits the read-backs better. Whether Mindcraft's library needs the other two changes on
  1.21.11 needs a live check.
- **The Docker setup** above is written but hasn't been built or run.
