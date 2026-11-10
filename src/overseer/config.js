// Overseer mode configuration: bots.json (validated by @mindcraft/bots's
// BotRuntimeConfigSchema, plus this fork's own `mindcraft` section) and the
// Mindcraft settings and profile each agent runs with under the overseer.
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { BotRuntimeConfigSchema } from '@mindcraft/bots';
import { FORK_ROOT } from './link.js';

export { FORK_ROOT };

/** Commands an agent can't use under the overseer, on top of the user's own `blocked_actions`. */
export const OVERSEER_BLOCKED_ACTIONS = [
    '!startConversation', // bot-to-bot talk rides the MindServer, which doesn't run under the overseer
    '!endConversation',
    '!restart',           // the bot's process belongs to the fleet launcher; the overseer decides restarts
    '!setMode',           // would undo the modes below
];

/**
 * Modes forced under the overseer (the rest keep the profile's choice).
 * - torch_placing, hunting: world changes and wandering nobody asked for (torches also spend inventory the board reserved).
 * - unstuck: the Warden owns stuck recovery (task_stuck, its playbooks); Mindcraft's would walk the bot off a task that is
 *   only waiting (for a completion verdict, say), and kills the agent when it fails.
 * - cheat: places blocks with /setblock chat commands, which are neither audited nor read back.
 */
export const OVERSEER_MODES = { torch_placing: false, hunting: false, unstuck: false, cheat: false };

/** Settings that overseer mode always sets, whatever settings.js or bots.json say. */
export const OVERSEER_FORCED_SETTINGS = {
    auth: 'offline',
    load_memory: false,     // bots don't survive a restart; the overseer re-initialises them
    init_message: null,     // no model call at spawn: an idle bot costs nothing
    auto_open_ui: false,    // no MindServer, no UI
    render_bot_view: false,
    allow_vision: false,
    speak: false,
    task: undefined,        // Mindcraft's own task system is off; briefs come from the overseer
    profiles: [],
};

/** The brief loop's limits (per task attempt). */
export const DEFAULT_BRIEF_LIMITS = { maxTurns: 12, maxMinutes: 10 };

const fail = (where, msg) => { throw new Error(`${where}: ${msg}`); };

/**
 * Read and validate bots.json. The shared part (server, cadence, bots) goes
 * through BotRuntimeConfigSchema; the fork's own keys are checked here:
 *   bots[].profile          a Mindcraft profile for that bot
 *   mindcraft.profile       the profile for bots that don't name one
 *   mindcraft.settings      settings.js overrides for every agent
 *   mindcraft.brief         { maxTurns, maxMinutes } for model-driven briefs
 */
export function loadBotsConfig(file) {
    const where = path.relative(FORK_ROOT, file) || file;
    if (!existsSync(file)) fail(where, 'not found (copy bots.example.json to bots.json, or set MINDCRAFT_BOTS_CONFIG)');
    let raw;
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { fail(where, `not JSON: ${err.message}`); }
    const parsed = BotRuntimeConfigSchema.safeParse(raw);
    if (!parsed.success) fail(where, parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
    const runtime = parsed.data;
    const seen = new Set();
    for (const b of runtime.bots) {
        const k = b.username.toLowerCase();
        if (seen.has(k)) fail(where, `bot ${b.username} is listed twice`);
        seen.add(k);
    }
    const mc = raw.mindcraft ?? {};
    if (typeof mc !== 'object' || Array.isArray(mc)) fail(where, 'mindcraft must be an object');
    const base = path.dirname(file);
    const profileFile = (p, at) => {
        if (typeof p !== 'string' || !p) fail(where, `${at} must be a path to a profile`);
        const abs = path.resolve(base, p);
        if (!existsSync(abs)) fail(where, `${at}: ${p} not found`);
        return abs;
    };
    // Paths in bots.json are relative to it; the default is upstream's own andy.json.
    const defaultProfile = mc.profile === undefined ? path.join(FORK_ROOT, 'andy.json') : profileFile(mc.profile, 'mindcraft.profile');
    const profiles = {};
    raw.bots.forEach((b, i) => { if (b.profile !== undefined) profiles[b.username] = profileFile(b.profile, `bots[${i}].profile`); });
    const settings = mc.settings ?? {};
    if (typeof settings !== 'object' || Array.isArray(settings)) fail(where, 'mindcraft.settings must be an object');
    const brief = { ...DEFAULT_BRIEF_LIMITS, ...(mc.brief ?? {}) };
    for (const k of ['maxTurns', 'maxMinutes']) {
        if (!(Number.isFinite(brief[k]) && brief[k] > 0)) fail(where, `mindcraft.brief.${k} must be a positive number`);
    }
    return {
        file,
        runtime,
        settings,
        brief,
        bot(username) {
            return runtime.bots.find(b => b.username.toLowerCase() === username.toLowerCase()) ?? null;
        },
        profileFor(username) {
            return profiles[username] ?? defaultProfile;
        },
    };
}

export function botsConfigPath(options = {}) {
    return path.resolve(FORK_ROOT, options.config ?? process.env.MINDCRAFT_BOTS_CONFIG ?? 'bots.json');
}

/**
 * The launcher's view (FactionInit.server, the FleetBot) must agree with
 * bots.json's: two files naming the same fleet must not drift apart.
 * Returns the problem, or null.
 */
export function checkAgreement(config, spec, server) {
    const mine = config.bot(spec.username);
    if (!mine) return `${spec.username} is not in ${path.basename(config.file)}`;
    const s = config.runtime.server;
    if (server.host !== s.host || server.port !== s.port) {
        return `the fleet config says ${server.host}:${server.port}, ${path.basename(config.file)} says ${s.host}:${s.port}`;
    }
    if (server.version && server.version !== s.version) {
        return `the fleet config says Minecraft ${server.version}, ${path.basename(config.file)} says ${s.version}`;
    }
    return null;
}

/** Model-generated code runs only inside a container. */
export function inContainer() {
    return existsSync('/.dockerenv') || existsSync('/run/.containerenv');
}

/**
 * The settings one agent runs with: settings.js (the user's), then
 * bots.json's overrides, then what overseer mode forces.
 */
export function agentSettings({ base, overrides = {}, server, username, profile, container = inContainer() }) {
    const s = { ...base, ...overrides, ...OVERSEER_FORCED_SETTINGS };
    s.host = server.host;
    s.port = server.port;
    s.minecraft_version = server.version;
    s.overseer = true;
    s.blocked_actions = [...new Set([...(s.blocked_actions ?? []), ...OVERSEER_BLOCKED_ACTIONS])];
    // !newAction: only when asked for *and* inside a container (model-generated code runs only in Docker).
    s.allow_insecure_coding = Boolean(s.allow_insecure_coding) && container;
    s.profile = profile;
    s.profile.name = username;
    return s;
}

/**
 * A bot's profile: the profile file, renamed to the bot, with the overseer's
 * modes forced on top of what the profile (or its base profile) chose.
 */
export function agentProfile(file, username, baseProfile = 'assistant') {
    const profile = JSON.parse(readFileSync(file, 'utf8'));
    const defaults = path.join(FORK_ROOT, 'profiles', 'defaults');
    const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {});
    const which = ['survival', 'assistant', 'creative', 'god_mode'].find(n => String(baseProfile).includes(n)) ?? 'assistant';
    const modes = {
        ...(read(path.join(defaults, '_default.json')).modes ?? {}),
        ...(read(path.join(defaults, `${which}.json`)).modes ?? {}),
        ...(profile.modes ?? {}),
        ...OVERSEER_MODES,
    };
    return { ...profile, name: username, modes };
}
