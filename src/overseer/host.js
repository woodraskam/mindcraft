// hostAgent: put a spawned Mindcraft agent on the overseer's seam.
//
//   attachBotClient(agent.bot, { transport, executor })   bot_status, read-back deltas, the task protocol
//   mindcraftExecutor(new BriefAgent(agent))              briefs -> agent.runTask (tasks.js)
//   skillCommands(client) as !skill_<name>                the library skills as Mindcraft commands
//   installReadBacks(agent.bot, client)                   raw-Mineflayer changes -> reportChangedBlocks/reportContainer
//
// `attach` is attachBotClient for a real bot; the simulated side passes its
// own (sim.js), which builds the same BotClient over a SimBot.
import { attachBotClient, mindcraftExecutor, skillCommands } from '@mindcraft/bots';
import { registerOverseerCommands } from './commands.js';
import { installReadBacks } from './readback.js';
import { BriefAgent } from './tasks.js';

export function hostAgent(agent, { transport, attach = attachBotClient, cadence, onError, brief: limits } = {}) {
    const controllers = new Set();
    const host = {
        agent,
        client: null,
        brief: new BriefAgent(agent, limits),
        skillCommands: new Map(),
        /** An AbortController that the agent's next interrupt aborts (for a running skill). */
        interruptible() {
            const c = new AbortController();
            controllers.add(c);
            return c;
        },
        settle(c) {
            controllers.delete(c);
        },
        interrupt() {
            for (const c of controllers) c.abort(new Error('interrupted by the agent'));
            controllers.clear();
        },
    };
    agent.overseer = host;
    const running = attach(agent.bot, {
        transport,
        executor: mindcraftExecutor(host.brief),
        ...(cadence ? { cadence } : {}),
        ...(onError ? { onError } : {}),
    });
    host.client = running.client;
    const commands = skillCommands(running.client);
    for (const sc of commands) host.skillCommands.set(sc.name, sc);
    registerOverseerCommands(commands);
    const uninstall = installReadBacks(agent.bot, running.client, onError ? { onError } : {});
    return {
        client: running.client,
        host,
        /** Release any held task (`interrupted`), report the disconnect, and quit the bot. */
        async close() {
            uninstall();
            host.interrupt();
            await running.close();
        },
    };
}
