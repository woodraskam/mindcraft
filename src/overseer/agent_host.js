// One bot's process under the overseer: what driver.js forks for each bot.
// Mindcraft runs one agent per process (src/process/init_agent.js upstream),
// and its agent is built that way: module-level singletons (settings, the
// MindServer proxy, the conversation manager, the mode controller) and
// process.exit() on a kick or a stuck action. So each bot keeps a process of
// its own here too, and talks to its faction process (the driver) over the
// IPC channel:
//
//   driver -> host   init, board (board -> bot task messages), command, close
//   host -> driver   online, failed, uplink (observations / task / skill), command_result, ending, closed
//
// The BotClient lives here, next to the Mineflayer bot it wraps; the faction
// process forwards its uplink to the dispatcher link unchanged and in order.
import rootSettings from '../../settings.js';
import { setSettings } from '../agent/settings.js';
import { agentProfile, agentSettings, botsConfigPath, checkAgreement, loadBotsConfig } from './config.js';

const realExit = process.exit.bind(process);
const sends = new Set();
let hosted = null;
let bot = null;
let ended = false;
let endReason = null;
let exiting = false;
let username = '(starting)';

function send(message) {
    if (!process.connected) return Promise.resolve();
    const p = new Promise((resolve) => {
        try {
            process.send(message, undefined, undefined, () => resolve());
        } catch {
            resolve();
        }
    });
    sends.add(p);
    p.finally(() => sends.delete(p));
    return p;
}

const drain = () => Promise.all([...sends]);

/**
 * The agent's exits all come through here. Upstream calls process.exit() on
 * a kick, a failed spawn, `cleanKill`, or an action that won't stop; in this
 * process that means: release the held task (`interrupted`), report the
 * disconnect, tell the driver why, flush the channel, then exit.
 */
async function shutdown({ code = 1, reason, clean = false }) {
    if (exiting) return;
    exiting = true;
    const hard = setTimeout(() => realExit(code), 5_000);
    await new Promise((r) => setImmediate(r)); // let the bot's other 'end' listeners (the client's) run first
    try {
        if (hosted && !ended) await hosted.close();
        else if (hosted) await hosted.client.stop();
    } catch (err) {
        console.error(`[${username}] shutting down:`, err);
    }
    await send({ type: clean ? 'closed' : 'ending', reason: endReason ?? reason });
    await drain();
    clearTimeout(hard);
    realExit(clean ? 0 : code);
}

process.exit = (code) => {
    void shutdown({ code: code ?? 0, reason: `the agent exited (code ${code ?? 0})` });
};

/** The BotTransport over the IPC channel. */
function ipcTransport() {
    const handlers = new Set();
    process.on('message', (m) => {
        if (m?.type === 'board') for (const h of handlers) h(m.message);
    });
    return {
        sendObservations: (batch) => void send({ type: 'uplink', channel: 'observations', payload: batch }),
        sendTaskMessage: (message) => void send({ type: 'uplink', channel: 'task', payload: message }),
        sendSkillInvoked: (event) => void send({ type: 'uplink', channel: 'skill', payload: event }),
        onBoardMessage(handler) {
            handlers.add(handler);
            return () => handlers.delete(handler);
        },
    };
}

function kickText(reason) {
    if (typeof reason === 'string') return reason;
    try { return JSON.stringify(reason); } catch { return String(reason); }
}

async function start(init) {
    username = init.bot.username;
    const config = loadBotsConfig(botsConfigPath(init.options));
    const disagreement = checkAgreement(config, init.bot, init.server);
    if (disagreement) throw new Error(disagreement);
    const server = { host: init.server.host, port: init.server.port, version: init.server.version ?? config.runtime.server.version };
    const base = { ...rootSettings, ...config.settings };
    const profile = agentProfile(config.profileFor(username), username, base.base_profile);
    setSettings(agentSettings({ base: rootSettings, overrides: config.settings, server, username, profile }));

    // Only now: Mindcraft reads settings while its modules load.
    const { OverseerAgent, assembleAgent, deferExampleLoading, detachFromMindServer } = await import('./agent.js');
    const { hostAgent } = await import('./host.js');
    const transport = ipcTransport();
    const onError = (err) => console.error(`[${username}]`, err instanceof Error ? err.message : err);
    detachFromMindServer(username);

    let agent;
    if (init.options?.sim) {
        // The simulated side: no server, a scripted model (driver option `sim`).
        const { simMindcraftBot, ScriptedPrompter } = await import('./sim.js');
        const sim = init.options.sim === true ? {} : init.options.sim;
        bot = simMindcraftBot(username, { give: sim.give ?? {}, version: server.version });
        agent = assembleAgent({ name: username, bot, prompter: new ScriptedPrompter(username, sim.replies ?? []) });
        // What Agent.start does on a kick or a dropped connection: exit the process.
        bot.once('end', () => process.exit(1));
        if (sim.kickAfterMs !== undefined) {
            // Rehearse a kick (`sim.kickAfterMs`), e.g. the server's anti-cheat.
            setTimeout(() => { bot.emit('kicked', sim.kickReason ?? 'Kicked for flying'); bot.quit('kicked'); }, sim.kickAfterMs);
        }
    } else {
        const { Prompter } = await import('../models/prompter.js');
        deferExampleLoading(Prompter);
        agent = new OverseerAgent();
        const { serverProxy } = await import('../agent/mindserver_proxy.js');
        serverProxy.setAgent(agent);
        await agent.start(false, null, 0); // logs in; returns before the spawn
        bot = agent.bot;
        bot.once('login', () => {
            try { bot.setSettings({ viewDistance: init.bot.viewDistance ?? 'tiny' }); } catch (err) { onError(err); }
        });
        await agent.whenReady();
    }
    bot.on('kicked', (reason) => { endReason ??= `kicked: ${kickText(reason)}`; });
    bot.on('end', (reason) => { ended = true; endReason ??= `connection ended: ${kickText(reason)}`; });

    hosted = hostAgent(agent, { transport, cadence: init.cadence, onError, brief: config.brief });
    process.on('message', (m) => {
        if (m?.type === 'command') {
            Promise.resolve()
                .then(() => hosted.client.handleCommand(m.envelope, m.skill))
                .catch((err) => ({ status: 'failed', detail: err instanceof Error ? err.message : String(err), at: Date.now() }))
                .then((result) => send({ type: 'command_result', id: m.id, result }));
        } else if (m?.type === 'close') {
            void shutdown({ code: 0, reason: m.reason ?? 'closed', clean: true });
        }
    });
    await send({ type: 'online', epoch: hosted.client.emitter.epoch });
}

if (!process.send) {
    console.error('agent_host.js is started by the overseer driver (src/overseer/driver.js), not by hand.');
    realExit(2);
}

process.once('message', (m) => {
    if (m?.type !== 'init') {
        console.error('[agent] the first message must be init');
        realExit(2);
    }
    start(m).catch(async (err) => {
        console.error(`[${username}] could not start:`, err instanceof Error ? err.message : err);
        if (hosted) return void shutdown({ code: 1, reason: err.message });
        await send({ type: 'failed', reason: endReason ?? (err instanceof Error ? err.message : String(err)) });
        await drain();
        realExit(1);
    });
});

process.on('disconnect', () => void shutdown({ code: 0, reason: 'the faction process went away' }));
process.on('uncaughtException', (err) => {
    console.error(`[${username}] uncaught:`, err);
    void shutdown({ code: 1, reason: `the agent crashed: ${err?.message ?? err}` });
});
process.on('unhandledRejection', (err) => console.error(`[${username}] unhandled rejection:`, err));
