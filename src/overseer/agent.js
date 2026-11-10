// The Mindcraft agent under the overseer: upstream's Agent with a few
// overrides, so no upstream file has to change for them.
//
// Import this module only after the agent's settings are in place
// (setSettings): src/utils/mcdata.js reads the Minecraft version when it loads.
import { Agent } from '../agent/agent.js';
import { ActionManager } from '../agent/action_manager.js';
import { History } from '../agent/history.js';
import { SelfPrompter } from '../agent/self_prompter.js';
import { MemoryBank } from '../agent/memory_bank.js';
import { blacklistCommands } from '../agent/commands/index.js';
import { serverProxy } from '../agent/mindserver_proxy.js';
import settings from '../agent/settings.js';

const BUSY_REPLY_EVERY_MS = 30_000;

export class OverseerAgent extends Agent {
    constructor() {
        super();
        /** Set by hostAgent (host.js): { client, brief, ... }. */
        this.overseer = null;
        this._lastBusyReply = 0;
    }

    /** Busy while the overseer's task runner holds a brief, so Mindcraft's idle behaviours stay out of its way. */
    isIdle() {
        return super.isIdle() && !this.overseer?.client?.tasks.current;
    }

    /** Mindcraft's interrupt (!stop, modes, a new action) also aborts the library skill that is running. */
    requestInterrupt() {
        super.requestInterrupt();
        this.overseer?.interrupt();
    }

    /**
     * While a brief is held, chat and system events don't start model turns:
     * the brief loop (tasks.js) is the only thing prompting the model, and a
     * whispered "come here" must not walk the bot off its task. The message
     * still goes into the history, so the agent knows about it afterwards.
     */
    async handleMessage(source, message, max_responses = null) {
        if (this.overseer?.client?.tasks.current) {
            if (!source || !message) return false;
            await this.history.add(source, message);
            const fromPlayer = source !== 'system' && source !== this.name;
            const now = Date.now();
            if (fromPlayer && now - this._lastBusyReply > BUSY_REPLY_EVERY_MS) {
                this._lastBusyReply = now;
                this.openChat(`Busy with a job for the overseer, ${source}. I'll get back to you.`);
            }
            return false;
        }
        return super.handleMessage(source, message, max_responses);
    }

    // Mindcraft's own task system is off under the overseer.
    checkAllPlayersPresent() {}
    async checkTaskDone() {}

    /** Resolves once upstream's spawn handling is done (event handlers, modes, the update loop). */
    whenReady() {
        this._ready ??= new Promise((resolve) => { this._resolveReady = resolve; });
        return this._ready;
    }

    startEvents() {
        super.startEvents();
        this.whenReady();
        this._resolveReady();
    }
}

/**
 * Agent.start() awaits the prompter's example selection (embedding calls)
 * before it logs in. Under the overseer the fleet launcher grants each login
 * a slot, spaced wider than the server's connection throttle, so the login
 * has to happen when the slot comes: the examples load in the background
 * instead, and the first model call waits for them.
 */
export function deferExampleLoading(Prompter) {
    if (Prompter.prototype._overseerDeferred) return;
    Prompter.prototype._overseerDeferred = true;
    const init = Prompter.prototype.initExamples;
    Prompter.prototype.initExamples = function () {
        this._examplesLoaded = init.call(this).catch((err) => console.error('Loading examples failed:', err));
        return Promise.resolve();
    };
    for (const name of ['promptConvo', 'promptCoding']) {
        const original = Prompter.prototype[name];
        Prompter.prototype[name] = async function (...args) {
            await this._examplesLoaded;
            return original.apply(this, args);
        };
    }
}

/**
 * No MindServer under the overseer. The proxy gets a socket that goes
 * nowhere (upstream emits to it for the UI), and a peer so that
 * getNumOtherAgents() > 0: like upstream with several agents, a bot answers
 * whispers but not open chat, so a dozen bots don't all call their model on
 * every chat line, including each other's.
 */
export function detachFromMindServer(name) {
    serverProxy.socket = { emit() {}, on() {}, off() {}, connected: false };
    serverProxy.connected = true;
    serverProxy.name = name;
    serverProxy.agents = [{ name, in_game: true }, { name: '(overseer)', in_game: true }];
}

/**
 * Build an agent around a bot that already exists (the simulated side, the
 * tests) instead of Agent.start(), which logs a real bot in. Same pieces as
 * start(), minus the ones that need a live server or are off under the
 * overseer (coder, vision, NPC goals, modes).
 */
export function assembleAgent({ name, bot, prompter, AgentClass = OverseerAgent }) {
    const agent = new AgentClass();
    agent.name = name;
    agent.count_id = 0;
    agent.last_sender = null;
    agent.shut_up = false;
    agent._disconnectHandled = false;
    agent.prompter = prompter;
    agent.actions = new ActionManager(agent);
    agent.history = new History(agent);
    agent.memory_bank = new MemoryBank();
    agent.self_prompter = new SelfPrompter(agent);
    agent.task = { data: null, blocked_actions: [] };
    agent.blocked_actions = [...(settings.blocked_actions ?? [])];
    blacklistCommands(agent.blocked_actions);
    agent.bot = bot;
    serverProxy.setAgent(agent);
    return agent;
}
