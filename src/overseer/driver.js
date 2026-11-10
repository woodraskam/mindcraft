// The bot driver the overseer's fleet launcher loads:
//
//   node <mindcraft-overseer>/bots/dist/cli.js fleet fleet.json --driver <this fork>/src/overseer/driver.js
//
// Each faction process calls `driver(bot, transport, context)` when the
// launcher grants that bot its login slot. The driver forks the bot's own
// agent process (agent_host.js: a Mindcraft agent on the @mindcraft/bots
// seam), forwards the bot's uplink to the faction's dispatcher link and the
// board's messages back, and hands the faction process a small client proxy
// (its epoch and a command handler, @mindcraft/bots's DrivenClient).
//
// Driver options (FleetLauncherOptions.driverOptions; the CLI passes none):
//   config        path to bots.json (default: $MINDCRAFT_BOTS_CONFIG, else <fork>/bots.json)
//   sim           true or { give, replies }: the simulated side, no server and no model (sim.js)
import { fork } from 'child_process';
import os from 'os';
import { fileURLToPath } from 'url';
import { FORK_ROOT, botsConfigPath, checkAgreement, loadBotsConfig } from './config.js';

const AGENT_HOST = fileURLToPath(new URL('./agent_host.js', import.meta.url));

/**
 * Below-normal priority for agent processes: twelve of them share the host
 * with the Minecraft server, whose tick thread must win (the reason the
 * fleet plan keeps bots out of the server's way).
 */
const AGENT_NICENESS = 10;

function prefixLines(stream, prefix, out) {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        const lines = (rest + chunk).split(/\r?\n/);
        rest = lines.pop() ?? '';
        for (const line of lines) out.write(`${prefix} ${line}\n`);
    });
    stream.on('end', () => { if (rest) out.write(`${prefix} ${rest}\n`); });
}

export function createDriver({ hostPath = AGENT_HOST, loginTimeoutMs = 180_000, commandTimeoutMs = 10_000, closeTimeoutMs = 10_000, niceness = AGENT_NICENESS } = {}) {
    return async function driver(spec, transport, ctx) {
        const options = ctx.options ?? {};
        // Fail fast, before a process starts: the two files naming this fleet must agree.
        const config = loadBotsConfig(botsConfigPath(options));
        const disagreement = checkAgreement(config, spec, ctx.server);
        if (disagreement) throw new Error(disagreement);

        const child = fork(hostPath, [], { cwd: FORK_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json' });
        prefixLines(child.stdout, `[${spec.username}]`, process.stdout);
        prefixLines(child.stderr, `[${spec.username}]`, process.stderr);
        try { os.setPriority(child.pid, niceness); } catch { /* not permitted here: run at normal priority */ }

        const pending = new Map();
        const endListeners = [];
        let seq = 0;
        let online = false;
        let closing = false;
        let exited = false;
        let reason = null;
        let epoch = null;
        let settleLogin;
        const login = new Promise((resolve, reject) => { settleLogin = { resolve, reject }; });

        const forward = (fn, payload) => {
            try {
                const r = fn(payload);
                if (r && typeof r.catch === 'function') r.catch(ctx.onError);
            } catch (err) {
                ctx.onError(err);
            }
        };
        child.on('message', (m) => {
            switch (m?.type) {
                case 'uplink':
                    if (m.channel === 'observations') forward((p) => transport.sendObservations(p), m.payload);
                    else if (m.channel === 'task') forward((p) => transport.sendTaskMessage(p), m.payload);
                    else if (m.channel === 'skill') forward((p) => transport.sendSkillInvoked(p), m.payload);
                    return;
                case 'online':
                    online = true;
                    epoch = m.epoch;
                    settleLogin.resolve();
                    return;
                case 'failed':
                case 'ending':
                    reason = m.reason;
                    return;
                case 'command_result': {
                    const done = pending.get(m.id);
                    if (done) done(m.result);
                    return;
                }
            }
        });
        const offBoard = transport.onBoardMessage((message) => {
            if (child.connected) child.send({ type: 'board', message });
        });
        const exit = new Promise((resolve) => {
            child.on('exit', (code, signal) => {
                exited = true;
                offBoard();
                for (const done of pending.values()) done({ status: 'failed', detail: `${spec.username}'s agent process exited`, at: Date.now() });
                pending.clear();
                const why = reason ?? `the agent process exited (${signal ?? `code ${code}`})`;
                if (!online) settleLogin.reject(new Error(why));
                else if (!closing) for (const l of endListeners) l(why);
                resolve();
            });
        });
        child.on('error', (err) => ctx.onError(err));

        child.send({ type: 'init', bot: spec, faction: ctx.faction, server: ctx.server, cadence: ctx.cadence, options });
        const timer = setTimeout(() => {
            if (!online) {
                reason ??= `no spawn within ${Math.round(loginTimeoutMs / 1000)} s`;
                child.kill();
            }
        }, loginTimeoutMs);
        try {
            await login;
        } finally {
            clearTimeout(timer);
        }

        const client = {
            username: spec.username,
            emitter: { get epoch() { return epoch; } },
            handleCommand(envelope, skill) {
                const at = Date.now();
                if (exited || !child.connected) return { status: 'failed', detail: `${spec.username}'s agent process is gone`, at };
                const id = ++seq;
                return new Promise((resolve) => {
                    const t = setTimeout(() => {
                        pending.delete(id);
                        resolve({ status: 'failed', detail: `${spec.username} did not answer within ${commandTimeoutMs} ms`, at: Date.now() });
                    }, commandTimeoutMs);
                    pending.set(id, (result) => {
                        clearTimeout(t);
                        pending.delete(id);
                        resolve(result);
                    });
                    child.send({ type: 'command', id, envelope, skill });
                });
            },
        };
        return {
            client,
            async close() {
                if (exited) return;
                closing = true;
                if (child.connected) child.send({ type: 'close', reason: 'shutting down' });
                const t = setTimeout(() => child.kill(), closeTimeoutMs);
                await exit;
                clearTimeout(t);
            },
            onEnd(listener) {
                endListeners.push(listener);
            },
        };
    };
}

/** What `--driver <this file>` loads. */
export const driver = createDriver();
