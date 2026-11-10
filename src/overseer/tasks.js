// How a task brief becomes agent work: `agent.runTask(brief, handle)` for
// mindcraftExecutor (@mindcraft/bots). The TaskRunner there owns the protocol
// (task_started, heartbeats, task_done and the completion loop, releases), so
// the model can't forget a heartbeat or claim "done" without the board
// checking the world. This file only decides how the work gets done:
//
// - Work the brief spells out block by block (place, clear, withdraw,
//   deposit, go to) is per-block work, so it is plain code: the agent
//   declines it to the deterministic BriefExecutor, with no model call.
// - Work it doesn't spell out (items to obtain that nobody reserved for the
//   task, a `custom` task with nothing resolved) is the model's: the agent
//   runs a bounded loop of model turns with Mindcraft's commands until the
//   items are in the inventory, the model says !taskDone, or it gives up.
//   Then it declines too, so the deterministic executor does whatever is
//   mechanical and makes the final carry check.
import { TaskProblem } from '@mindcraft/bots';
import { commandExists, containsCommand, executeCommand, truncCommandMessage } from '../agent/commands/index.js';
import { DEFAULT_BRIEF_LIMITS } from './config.js';

const bare = (name) => String(name).replace(/^minecraft:/, '');

function add(into, items, sign = 1) {
    for (const [k, n] of Object.entries(items ?? {})) into[bare(k)] = (into[bare(k)] ?? 0) + sign * n;
}

/** What a brief needs the bot to obtain by itself, and whether there's mechanical work for the BriefExecutor. */
export function planBrief(brief, inventory) {
    const r = brief.resolved;
    const needs = {};
    add(needs, r.carry);
    for (const d of r.deposit) add(needs, d.items);
    for (const w of r.withdraw) add(needs, w.items, -1);
    for (const k of Object.keys(needs)) if (needs[k] <= 0) delete needs[k];
    const mechanical = r.place.length + r.clear.length + r.withdraw.length + r.deposit.length + r.goTo.length > 0;
    const short = shortfall(needs, inventory);
    const openEnded = !mechanical && Object.keys(needs).length === 0 && brief.task.kind === 'custom';
    return { needs, short, mechanical, model: Object.keys(short).length > 0 || openEnded, openEnded };
}

export function shortfall(needs, inventory) {
    const out = {};
    for (const [k, n] of Object.entries(needs)) {
        const have = inventory[k] ?? 0;
        if (have < n) out[k] = n - have;
    }
    return out;
}

const list = (items) => Object.entries(items).map(([k, n]) => `${n} ${k}`).join(', ');

export function goalPrompt(brief, plan, inventory, skills) {
    const lines = [
        `[Overseer task ${brief.key}, attempt ${brief.attempt}, ${brief.task.kind}] ${brief.task.summary}.`,
    ];
    if (Object.keys(plan.needs).length > 0) {
        lines.push(`You need to have: ${list(plan.needs)}. You have: ${list(Object.fromEntries(Object.keys(plan.needs).map(k => [k, inventory[k] ?? 0])))}.`);
        lines.push('Obtain the rest yourself (gather, mine, craft, smelt). Only use chests the task names.');
    }
    if (skills.length > 0) lines.push(`Library skills for this task: ${skills.join(', ')}.`);
    lines.push('Work only on this task, one command per response.');
    lines.push('When it is finished, respond with !taskDone. If it cannot be done, respond with !giveUpTask("<code>", "<reason>").');
    return lines.join('\n');
}

export function progressPrompt(brief, plan, inventory, turn, maxTurns) {
    const short = shortfall(plan.needs, inventory);
    const left = Object.keys(short).length > 0 ? `Still missing: ${list(short)}.` : '';
    return `[Overseer task ${brief.key}] ${left} Turn ${turn + 1} of ${maxTurns}. Next command:`.replace('  ', ' ');
}

/**
 * One model turn for a brief, built from upstream's command functions
 * rather than Agent.handleMessage, so a cancel between the model's answer
 * and its command stops the command from running.
 */
export async function briefTurn(agent, prompt, signal) {
    await agent.history.add('system', prompt);
    const res = await agent.prompter.promptConvo(agent.history.getHistory());
    if (signal.aborted) return { aborted: true };
    if (!res || res.trim().length === 0) return { command: null };
    const name = containsCommand(res);
    if (!name) {
        await agent.history.add(agent.name, res);
        return { command: null, text: res };
    }
    const said = truncCommandMessage(res);
    await agent.history.add(agent.name, said);
    if (!commandExists(name)) {
        await agent.history.add('system', `Command ${name} does not exist.`);
        return { command: name, missing: true };
    }
    const chatter = said.substring(0, said.indexOf(name)).trim();
    if (chatter) agent.openChat(chatter); // flavour only; the overseer hears nothing from chat
    const output = await executeCommand(agent, said);
    if (output) await agent.history.add('system', output);
    return { command: name, output };
}

/** The agent side of mindcraftExecutor: `runTask(brief, handle)`. */
export class BriefAgent {
    constructor(agent, limits = {}) {
        this.agent = agent;
        this.limits = { ...DEFAULT_BRIEF_LIMITS, ...limits };
        this.now = limits.now ?? Date.now;
        /** The brief in the model loop: { brief, handle, done, giveUp }. */
        this.current = null;
        this.turns = 0;
    }

    /** From !taskDone / !giveUpTask. */
    report(signal) {
        if (!this.current) return 'No overseer task is running.';
        if (signal.done) this.current.done = true;
        if (signal.giveUp) this.current.giveUp = signal.giveUp;
        return signal.done ? 'Reported done; the overseer will check the world.' : 'Reported to the overseer; stop working on this task.';
    }

    inventory() {
        const out = {};
        for (const item of this.agent.bot.inventory.items()) out[item.name] = (out[item.name] ?? 0) + item.count;
        return out;
    }

    async runTask(brief, handle) {
        await this._preempt();
        const plan = planBrief(brief, this.inventory());
        if (!plan.model) return 'decline';
        const onAbort = () => this.agent.requestInterrupt();
        handle.signal.addEventListener('abort', onAbort, { once: true });
        this.current = { brief, handle, done: false, giveUp: null };
        try {
            await this._loop(brief, handle, plan);
        } finally {
            handle.signal.removeEventListener('abort', onAbort);
            this.current = null;
        }
        return 'decline';
    }

    async _loop(brief, handle, plan) {
        const { maxTurns, maxMinutes } = this.limits;
        const deadline = this.now() + maxMinutes * 60_000;
        const skills = brief.resolved.skills.map(s => `!skill_${s.split('@')[0]}`).filter(n => commandExists(n));
        handle.phase('working', `mindcraft: ${brief.task.summary}`);
        for (let turn = 0; ; turn++) {
            handle.checkpoint();
            const c = this.current;
            if (c.giveUp) throw new TaskProblem(c.giveUp.code, `the agent gave up: ${c.giveUp.reason}`);
            const short = shortfall(plan.needs, this.inventory());
            if (c.done || (!plan.openEnded && Object.keys(short).length === 0)) return;
            if (turn >= maxTurns) throw new TaskProblem('timeout', `not done after ${maxTurns} model turns${Object.keys(short).length ? `; still missing ${list(short)}` : ''}`);
            if (this.now() > deadline) throw new TaskProblem('timeout', `not done after ${maxMinutes} min`);
            const prompt = turn === 0 ? goalPrompt(brief, plan, this.inventory(), skills) : progressPrompt(brief, plan, this.inventory(), turn, maxTurns);
            this.turns++;
            const r = await briefTurn(this.agent, prompt, handle.signal);
            handle.checkpoint();
            if (r.command) handle.phase('working', `mindcraft: ${r.command}`);
        }
    }

    /** A brief preempts whatever the agent was doing on its own: its self-prompted goal (paused, not resumed) and any action. */
    async _preempt() {
        const a = this.agent;
        if (a.self_prompter.isActive()) await a.self_prompter.pause();
        a.actions.cancelResume();
        await a.actions.stop();
    }
}
