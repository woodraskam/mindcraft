// Shared set-up for the overseer-mode tests: settings first (Mindcraft reads
// some at import time), then the agent modules, then agents on the simulated
// side with a scripted model. Nothing here touches a server or a model API.
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import rootSettings from '../../../settings.js';
import { setSettings } from '../../agent/settings.js';
import { agentSettings } from '../config.js';

export const SERVER = { host: '127.0.0.1', port: 25565, version: '1.21.11' };

setSettings(agentSettings({
    base: rootSettings,
    server: SERVER,
    username: 'Overseer_Test',
    profile: { name: 'Overseer_Test', modes: {} },
    container: false,
}));

const { assembleAgent, detachFromMindServer } = await import('../agent.js');
const { hostAgent } = await import('../host.js');
const { simMindcraftBot, ScriptedPrompter } = await import('../sim.js');
const bots = await import('@mindcraft/bots');

export { assembleAgent, detachFromMindServer, hostAgent, simMindcraftBot, ScriptedPrompter, bots };

/**
 * Import a package from the mindcraft-overseer checkout that @mindcraft/bots
 * is linked to (the dispatcher, the board...): the tests use the real service
 * side without the fork depending on it.
 */
export async function overseerPackage(name) {
    const botsEntry = fileURLToPath(import.meta.resolve('@mindcraft/bots'));
    // Resolved from inside the bots package, so its workspace siblings are found (their "default" export).
    return import(pathToFileURL(createRequire(botsEntry).resolve(name)).href);
}

/** An agent on the simulated side, hosted on the seam with an in-memory transport. */
export function simAgent(name, { replies = [], give = {}, cadence = { statusEveryMs: 30_000, deltaFlushMs: 100 }, transport = new bots.MemoryTransport(), brief } = {}) {
    detachFromMindServer(name);
    const bot = simMindcraftBot(name, { give });
    const prompter = new ScriptedPrompter(name, replies);
    const agent = assembleAgent({ name, bot, prompter });
    const errors = [];
    const hosted = hostAgent(agent, { transport, cadence, onError: (e) => errors.push(e), ...(brief ? { brief } : {}) });
    return { agent, bot, prompter, transport, errors, ...hosted };
}

export async function until(read, what, ms = 5_000) {
    const deadline = Date.now() + ms;
    for (;;) {
        const v = await read();
        if (v) return v;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A task brief for `bot` (TaskBriefSchema fills the defaults). */
export function makeBrief(bot, { key = 'site/pad', attempt = 1, kind = 'build', summary = 'a cobblestone pad', resolved = {}, done } = {}) {
    return {
        type: 'task_brief',
        protocol: 'task/1',
        key,
        attempt,
        bot,
        at: Date.now(),
        orderId: key.split('/')[0],
        task: {
            id: key.split('/')[1],
            kind,
            summary,
            done: done ?? [{ type: 'blocks_match', blocks: [{ x: 2, y: 64, z: 0, block: 'minecraft:cobblestone' }] }],
        },
        boardRevision: 1,
        worldRevision: 1,
        resolved: { place: [], clear: [], withdraw: [], deposit: [], goTo: [], carry: {}, skills: [], ...resolved },
        heartbeatEveryMs: 1_000,
    };
}

export const taskTypes = (t) => t.taskMessages.map((m) => m.type);
export const observed = (t) => t.batches.flatMap((b) => b.events);
