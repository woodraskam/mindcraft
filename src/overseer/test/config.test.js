// bots.json, the settings and profile an agent runs with under the overseer,
// and the skill-schema flattening behind the !skill_<name> commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { bots } from './helpers.js';
import { FORK_ROOT, OVERSEER_BLOCKED_ACTIONS, agentProfile, agentSettings, checkAgreement, loadBotsConfig } from '../config.js';
import { flattenSchema } from '../commands.js';

function write(content) {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'overseer-cfg-')), 'bots.json');
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
}

test('the committed bots.example.json is valid and matches the fleet plan: 4 factions x 3 bots', () => {
    const c = loadBotsConfig(path.join(FORK_ROOT, 'bots.example.json'));
    assert.equal(c.runtime.bots.length, 12);
    assert.deepEqual(c.runtime.server, { host: '127.0.0.1', port: 25565, version: '1.21.11' });
    assert.ok(c.runtime.bots.every((b) => b.viewDistance === 'tiny' && b.role === 'worker'));
    assert.equal(c.bot('lodge_1').username, 'Lodge_1', 'names compare without case, as the server does');
});

test('bots.json is validated: the shared schema, then the fork\'s own section', () => {
    const profile = path.join(FORK_ROOT, 'andy.json');
    assert.throws(() => loadBotsConfig(write('{nope')), /not JSON/);
    assert.throws(() => loadBotsConfig(write({ bots: [] })), /bots/);
    assert.throws(() => loadBotsConfig(write({ bots: [{ username: 'not a name!' }] })), /bots\.0\.username/);
    assert.throws(() => loadBotsConfig(write({ bots: [{ username: 'A_1' }, { username: 'a_1' }] })), /listed twice/);
    assert.throws(() => loadBotsConfig(write({ bots: [{ username: 'A_1', profile: './nope.json' }] })), /bots\[0\]\.profile: \.\/nope\.json not found/);
    assert.throws(() => loadBotsConfig(write({ bots: [{ username: 'A_1' }], mindcraft: { brief: { maxTurns: 0 } } })), /maxTurns must be a positive number/);
    const c = loadBotsConfig(write({ bots: [{ username: 'A_1', profile }, { username: 'B_1' }], mindcraft: { profile, brief: { maxTurns: 4 } } }));
    assert.equal(c.profileFor('A_1'), profile);
    assert.deepEqual(c.brief, { maxTurns: 4, maxMinutes: 10 });
    assert.ok(bots.BotRuntimeConfigSchema, 'the shared part is @mindcraft/bots\'s schema');
});

test('the launcher\'s fleet config and bots.json must agree on the server and the bot', () => {
    const c = loadBotsConfig(write({ server: { port: 25570 }, bots: [{ username: 'A_1' }] }));
    assert.equal(checkAgreement(c, { username: 'A_1' }, { host: '127.0.0.1', port: 25570 }), null);
    assert.match(checkAgreement(c, { username: 'B_1' }, { host: '127.0.0.1', port: 25570 }), /B_1 is not in bots\.json/);
    assert.match(checkAgreement(c, { username: 'A_1' }, { host: '127.0.0.1', port: 25565 }), /25565.*25570/);
    assert.match(checkAgreement(c, { username: 'A_1' }, { host: '127.0.0.1', port: 25570, version: '1.21.6' }), /Minecraft 1\.21\.6.*1\.21\.11/);
});

test('overseer mode forces its settings: no MindServer, no memory or task system, no model call at spawn, codegen only in a container', () => {
    const base = { allow_insecure_coding: true, load_memory: true, init_message: 'hi', blocked_actions: ['!checkBlueprint'], chat_ingame: true, task: { id: 'x' } };
    const server = { host: '10.0.0.2', port: 25570, version: '1.21.11' };
    const outside = agentSettings({ base, server, username: 'A_1', profile: { name: 'x' }, container: false });
    assert.equal(outside.allow_insecure_coding, false);
    assert.deepEqual([outside.load_memory, outside.init_message, outside.auto_open_ui, outside.task, outside.overseer], [false, null, false, undefined, true]);
    assert.deepEqual([outside.host, outside.port, outside.minecraft_version, outside.auth], ['10.0.0.2', 25570, '1.21.11', 'offline']);
    assert.deepEqual(outside.blocked_actions, ['!checkBlueprint', ...OVERSEER_BLOCKED_ACTIONS]);
    assert.equal(outside.profile.name, 'A_1');
    assert.equal(outside.chat_ingame, true, 'chat stays: it is flavour');
    assert.equal(agentSettings({ base, server, username: 'A_1', profile: {}, container: true }).allow_insecure_coding, true);
    assert.equal(agentSettings({ base: { ...base, allow_insecure_coding: false }, server, username: 'A_1', profile: {}, container: true }).allow_insecure_coding, false);
});

test('a bot\'s profile is renamed to the bot and the overseer\'s modes are forced on top of the profile\'s', () => {
    const p = agentProfile(path.join(FORK_ROOT, 'andy.json'), 'Lodge_1', 'survival');
    assert.equal(p.name, 'Lodge_1');
    assert.equal(p.model, 'gpt-5.4-mini');
    assert.deepEqual(
        [p.modes.torch_placing, p.modes.hunting, p.modes.unstuck, p.modes.cheat, p.modes.self_preservation, p.modes.self_defense, p.modes.item_collecting],
        [false, false, false, false, true, true, true],
    );
});

test('skill input schemas flatten into Mindcraft params and rebuild into skill args', () => {
    const fell = flattenSchema({
        type: 'object',
        properties: { tree: { type: 'object', properties: { min: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' } } }, max: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' } } } } } },
    });
    assert.deepEqual(Object.keys(fell.params), ['tree_min_x', 'tree_min_y', 'tree_min_z', 'tree_max_x', 'tree_max_y', 'tree_max_z']);
    assert.deepEqual(fell.build([1, 2, 3, 4, 5, 6]), { tree: { min: { x: 1, y: 2, z: 3 }, max: { x: 4, y: 5, z: 6 } } });
    const dep = flattenSchema({
        type: 'object',
        properties: {
            chest: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' } } },
            items: { type: 'object', additionalProperties: { type: 'integer' } },
            max_gap: { type: 'integer', minimum: 1, maximum: 64, default: 16, description: 'Refuse wider gaps.' },
        },
    });
    assert.deepEqual(Object.fromEntries(Object.entries(dep.params).map(([k, v]) => [k, v.type])), { chest_x: 'int', chest_y: 'int', chest_z: 'int', items: 'string', max_gap: 'int' });
    assert.deepEqual(dep.params.max_gap.domain, [1, 64, '[]']);
    assert.match(dep.params.max_gap.description, /Refuse wider gaps\.; default 16/);
    assert.deepEqual(dep.build([1, 64, 2, "{'cobblestone': 5}", 16]), { chest: { x: 1, y: 64, z: 2 }, items: { cobblestone: 5 }, max_gap: 16 });
    assert.throws(() => dep.build([1, 64, 2, 'nope', 16]), /Param 'items' must be JSON/);
});
