// The overseer's commands in Mindcraft's command format:
// - `!skill_<name>`: the Toolsmith's library skills (skillCommands from
//   @mindcraft/bots), so the model calls a tested skill instead of writing
//   JavaScript for it, and every run is recorded (`skill_invoked`).
// - `!taskDone` / `!giveUpTask`: how the model ends a brief it is working.
//
// Mindcraft commands take positional arguments of simple types (numbers,
// booleans, double-quoted strings without inner quotes), so a skill's JSON
// input schema is flattened: nested objects become one parameter per leaf
// (`tree_min_x`), and arrays or maps become one JSON string parameter, in
// which single quotes stand for double ones.
import { registerCommands } from '../agent/commands/index.js';

export const PROBLEM_CODES = [
    'path_blocked', 'unreachable', 'no_tool', 'inventory_full', 'hazard', 'missing_materials', 'interrupted', 'timeout',
    'container_missing', 'block_unplaceable', 'zone_obstructed', 'other',
];

const LEAF = { integer: 'int', number: 'float', boolean: 'boolean', string: 'string' };

function describe(s, extra = '') {
    const bits = [s.description ?? '', extra];
    if (s.default !== undefined) bits.push(`default ${JSON.stringify(s.default)}`);
    if (s.enum) bits.push(`one of ${s.enum.join(', ')}`);
    return bits.filter(Boolean).join('; ') || 'value';
}

/** Flatten a skill's JSON input schema into Mindcraft params plus a function that rebuilds the args object. */
export function flattenSchema(schema) {
    const params = {};
    const slots = []; // { name, path, json }
    const walk = (s, path) => {
        const name = path.join('_');
        const isObject = s.type === 'object' && s.properties && !(s.additionalProperties && typeof s.additionalProperties === 'object');
        if (isObject && path.length > 0 && path.length < 4) {
            for (const [k, sub] of Object.entries(s.properties)) walk(sub, [...path, k]);
            return;
        }
        if (LEAF[s.type]) {
            const p = { type: LEAF[s.type], description: describe(s) };
            if ((s.type === 'integer' || s.type === 'number') && (s.minimum !== undefined || s.maximum !== undefined)) {
                p.domain = [s.minimum ?? -Infinity, s.maximum ?? Infinity, '[]'];
            }
            params[name] = p;
            slots.push({ name, path, json: false });
            return;
        }
        params[name] = { type: 'string', description: describe(s, 'JSON, single quotes allowed') };
        slots.push({ name, path, json: true });
    };
    for (const [k, sub] of Object.entries(schema?.properties ?? {})) walk(sub, [k]);

    const build = (args) => {
        const out = {};
        slots.forEach((slot, i) => {
            let v = args[i];
            if (slot.json) {
                try { v = JSON.parse(v); } catch {
                    try { v = JSON.parse(String(v).replaceAll("'", '"')); } catch {
                        throw new Error(`Param '${slot.name}' must be JSON, e.g. "[{'x':1,'y':64,'z':2,'block':'stone'}]"`);
                    }
                }
            }
            let at = out;
            slot.path.slice(0, -1).forEach(k => { at = at[k] ??= {}; });
            at[slot.path.at(-1)] = v;
        });
        return out;
    };
    return { params, build };
}

/** One line on how a skill run went, for the model's history. */
export function summarizeInvocation(inv) {
    const o = inv.outcome;
    const head = `Skill ${inv.skill.name}@${inv.skill.version}`;
    if (o.status === 'succeeded') return `${head} succeeded${o.detail ? `: ${o.detail}` : ''}.`;
    return `${head} ${o.status} (${o.code}): ${o.detail}`;
}

/**
 * Mindcraft commands for the client's skills. They are registered once per
 * process (Mindcraft's command table is global) and look the skill up on
 * the calling agent's own client, so they also work with several agents in
 * one process (the tests).
 */
export function skillMindcraftCommands(commands) {
    return commands.map(sc => {
        const { params, build } = flattenSchema(sc.inputSchema);
        return {
            name: sc.name,
            description: `${sc.description} (Library skill ${sc.skill}: tested, and reported to the overseer. Prefer it over !newAction.)`,
            params,
            perform: (agent, ...args) => {
                let input;
                try { input = build(args); } catch (err) { return Promise.resolve(err.message); }
                return runSkillCommand(agent, sc.name, input);
            },
        };
    });
}

/** Run a skill as a Mindcraft action: busy while it runs, aborted by any Mindcraft interrupt. */
export async function runSkillCommand(agent, name, input) {
    const host = agent.overseer;
    const sc = host?.skillCommands.get(name);
    if (!sc) return `${name} is not available: this agent isn't linked to the overseer.`;
    let summary = '';
    const res = await agent.actions.runAction(`action:${name.slice(1)}`, async () => {
        const control = host.interruptible();
        try {
            const brief = host.brief?.current;
            const signals = brief ? [control.signal, brief.handle.signal] : [control.signal];
            const context = brief ? { task: brief.brief.key, attempt: String(brief.brief.attempt) } : undefined;
            const inv = await sc.perform(input, context, { signal: AbortSignal.any(signals) });
            summary = summarizeInvocation(inv);
            agent.bot.output += summary + '\n';
        } finally {
            host.settle(control);
        }
    }, { timeout: -1 });
    if (res.interrupted && !res.timedout) return summary || `${name} was interrupted.`;
    return res.message;
}

/** !taskDone and !giveUpTask: how the model ends a brief (tasks.js). */
export function overseerTaskCommands() {
    return [
        {
            name: '!taskDone',
            description: 'Tell the overseer you finished your current overseer task. The overseer checks the world before it agrees. Only for overseer tasks.',
            perform: (agent) => Promise.resolve(agent.overseer?.brief?.report({ done: true }) ?? 'No overseer task is running.'),
        },
        {
            name: '!giveUpTask',
            description: 'Give up your current overseer task when it cannot be done, saying why. Only for overseer tasks.',
            params: {
                code: { type: 'string', description: `why, one of: ${PROBLEM_CODES.join(', ')}` },
                reason: { type: 'string', description: 'a short explanation for the overseer' },
            },
            perform: (agent, code, reason) => {
                const c = PROBLEM_CODES.includes(code) ? code : 'other';
                return Promise.resolve(agent.overseer?.brief?.report({ giveUp: { code: c, reason: reason || 'no reason given' } }) ?? 'No overseer task is running.');
            },
        },
    ];
}

let registered = false;
/** Register the overseer's commands with Mindcraft's command table (once per process). */
export function registerOverseerCommands(skillCommandList) {
    if (registered) return;
    registered = true;
    registerCommands([...skillMindcraftCommands(skillCommandList), ...overseerTaskCommands()]);
}
