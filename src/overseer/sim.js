// The simulated side for overseer mode: no Minecraft server, no model.
// - simMindcraftBot: @mindcraft/bots's SimBot (an in-memory flat world, chests,
//   an inventory) plus the bits of a Mineflayer bot that Mindcraft's agent and
//   attachBotClient touch: a pathfinder that teleports, mode and plugin stubs.
//   attachBotClient runs on it unchanged, real PathfinderNavigator included.
// - ScriptedPrompter: a stand-in for Mindcraft's Prompter that answers from a
//   script (strings, or functions of the history) and makes no API calls.
// Used by the offline tests and by the driver's `sim` option, which rehearses
// the fleet launcher, the dispatcher link and the task protocol end to end.
import { createRequire } from 'module';
import { SimBot } from '@mindcraft/bots';

const require = createRequire(import.meta.url);

function goalTarget(goal) {
    if (!goal) return null;
    return { x: goal.x, y: goal.y, z: goal.z, range: goal.rangeSq !== undefined ? Math.sqrt(goal.rangeSq) : 0 };
}

/** A pathfinder stand-in: goto teleports next to the goal; it records what it was asked. */
function simPathfinder(bot) {
    let movements = null;
    let stopPending = false;
    const pf = {
        calls: [],
        get movements() { return movements; },
        setMovements(m) { movements = m; pf.calls.push(`setMovements canDig=${m?.canDig}`); },
        setGoal(goal) { pf.calls.push(goal === null ? 'setGoal null' : 'setGoal goal'); stopPending = false; },
        isMoving() { return false; },
        stop() { stopPending = true; pf.calls.push('stop'); },
        async goto(goal) {
            pf.calls.push('goto');
            await Promise.resolve();
            if (stopPending) { stopPending = false; throw new Error('Path was stopped before it could be completed!'); }
            const t = goalTarget(goal);
            if (!t) return;
            const p = bot.entity.position;
            const d = Math.hypot(t.x - p.x, t.z - p.z);
            if (t.range <= 0) bot.entity.position = { x: Math.floor(t.x) + 0.5, y: Math.floor(t.y), z: Math.floor(t.z) + 0.5 };
            else if (d > t.range) {
                const keep = Math.max(0, t.range - 0.5) / d;
                bot.entity.position = { x: t.x + (p.x - t.x) * keep, y: Math.floor(t.y), z: t.z + (p.z - t.z) * keep };
            }
        },
    };
    return pf;
}

export function simMindcraftBot(username, { give = {}, version = '1.21.11' } = {}) {
    const bot = new SimBot(username);
    // PathfinderNavigator builds real mineflayer-pathfinder Movements, which read the block registry.
    const mcData = require('minecraft-data')(version);
    // SimBot's own item lookups (its ids) first, the real registry for everything else.
    const own = bot.registry;
    bot.registry = new Proxy(own, { get: (target, key) => (key in target ? target[key] : mcData[key]) });
    for (const [item, n] of Object.entries(give)) bot.give(item, n);
    bot.pathfinder = simPathfinder(bot);
    bot.chatLog = [];
    bot.output = '';
    bot.interrupt_code = false;
    bot.players = {};
    bot.heldItem = null;
    bot.chat = (m) => { bot.chatLog.push(m); };
    bot.whisper = (to, m) => { bot.chatLog.push(`/msg ${to} ${m}`); };
    bot.stopDigging = () => {};
    bot.clearControlStates = () => {};
    bot.collectBlock = { cancelTask() {} };
    bot.pvp = { stop() {} };
    bot.modes = {
        flushBehaviorLog: () => '',
        update: async () => {},
        pause() {}, unpause() {}, unPauseAll() {},
        isOn: () => false,
        getMiniDocs: () => '',
        getDocs: () => '',
    };
    return bot;
}

/** Mindcraft's Prompter, scripted. Each reply is a string or (history) => string | Promise<string>. */
export class ScriptedPrompter {
    constructor(name, replies = []) {
        this.name = name;
        this.replies = [...replies];
        this.calls = [];
        this.profile = { name };
    }
    getName() { return this.name; }
    getInitModes() { return null; }
    async initExamples() {}
    async promptConvo(history) {
        this.calls.push(history);
        const next = this.replies.shift();
        if (typeof next === 'function') return await next(history);
        return next ?? '';
    }
    promptMemSaving() { return Promise.resolve(''); }
    promptShouldRespondToBot() { return Promise.resolve(false); }
}
