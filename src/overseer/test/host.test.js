// The agent on the seam, in one process: a real Mindcraft agent object (its
// command system, action manager and history), the real @mindcraft/bots
// BotClient and attachBotClient, the simulated Minecraft side, and a scripted
// model. No server, no model API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBrief, observed, simAgent, sleep, taskTypes, until } from './helpers.js';

const TREE = [{ x: 4, y: 64, z: 0 }, { x: 4, y: 65, z: 0 }, { x: 4, y: 66, z: 0 }];
const plantTree = (bot) => TREE.forEach((p) => bot.setBlock(p, 'oak_log', { axis: 'y' }));
const FELL = '!skill_fell_tree(4, 64, 0, 4, 66, 0)';
const accept = (a, brief) => a.transport.deliver({
    type: 'completion_result', protocol: 'task/1', key: brief.key, attempt: brief.attempt, bot: brief.bot, at: Date.now(), accepted: true, unmet: [], worldRevision: 2,
});

test('a brief with its blocks spelled out is declined to the deterministic executor, worked to done, no model call', async (t) => {
    const a = simAgent('Lodge_1', { give: { cobblestone: 8 } });
    t.after(() => a.close());
    const brief = makeBrief('Lodge_1', { resolved: { place: [{ x: 2, y: 64, z: 0, block: 'minecraft:cobblestone' }, { x: 3, y: 64, z: 0, block: 'minecraft:cobblestone' }] } });
    a.transport.deliver(brief);
    assert.equal(a.agent.isIdle(), false, 'busy while the brief is held');
    await until(() => taskTypes(a.transport).includes('task_done'), 'task_done');
    // The deltas that prove the work went out before the claim.
    const log = a.transport.log.map((x) => (x.channel === 'task' ? x.message.type : x.channel));
    assert.ok(log.indexOf('observations') < log.indexOf('task_done'));
    const blocks = observed(a.transport).filter((e) => e.type === 'blocks_observed').flatMap((e) => e.blocks);
    assert.deepEqual(blocks.map((b) => `${b.x},${b.block}`).sort(), ['2,minecraft:cobblestone', '3,minecraft:cobblestone']);
    accept(a, brief);
    await a.client.tasks.whenIdle();
    assert.equal(a.client.tasks.current, null);
    assert.equal(a.agent.isIdle(), true);
    assert.equal(a.prompter.calls.length, 0, 'per-block work never reaches the model');
    assert.deepEqual(taskTypes(a.transport).slice(0, 2), ['task_started', 'task_progress']);
    assert.deepEqual(a.errors, []);
});

test('a brief that needs items nobody reserved is worked by the model with a library skill, then finished by the executor', async (t) => {
    const a = simAgent('Lodge_2', { replies: [FELL] });
    t.after(() => a.close());
    plantTree(a.bot);
    const brief = makeBrief('Lodge_2', {
        key: 'camp/logs', kind: 'gather', summary: 'fetch three oak logs',
        resolved: { carry: { oak_log: 3 }, skills: ['fell_tree@1.0.0'] },
        done: [{ type: 'bot_has_items', bot: 'Lodge_2', items: { oak_log: 3 } }],
    });
    a.transport.deliver(brief);
    await until(() => taskTypes(a.transport).includes('task_done'), 'task_done');
    assert.equal(a.prompter.calls.length, 1, 'one model turn: the skill got the logs');
    const goal = a.prompter.calls[0].at(-1).content;
    assert.match(goal, /\[Overseer task camp\/logs, attempt 1, gather\] fetch three oak logs/);
    assert.match(goal, /You need to have: 3 oak_log\. You have: 0 oak_log/);
    assert.match(goal, /!skill_fell_tree/);
    assert.equal(a.bot.count('oak_log'), 3);
    // The skill ran inside the task: its record carries the task, and the logs' removal was read back.
    assert.equal(a.transport.skillEvents.length, 1);
    assert.deepEqual(a.transport.skillEvents[0].invocation.context, { task: 'camp/logs', attempt: '1' });
    assert.equal(a.transport.skillEvents[0].invocation.outcome.status, 'succeeded');
    const air = observed(a.transport).filter((e) => e.type === 'blocks_observed').flatMap((e) => e.blocks).filter((b) => b.x === 4);
    assert.deepEqual(new Set(air.map((b) => b.block)), new Set(['minecraft:air']));
    const notes = a.transport.taskMessages.filter((m) => m.type === 'task_progress').map((m) => m.note);
    assert.ok(notes.includes('mindcraft: !skill_fell_tree'));
    accept(a, brief);
    await a.client.tasks.whenIdle();
});

test('a cancel mid-task stops the model loop quietly, and the command the model was choosing never runs', async (t) => {
    let answer;
    const thinking = new Promise((r) => { answer = r; });
    const a = simAgent('Lodge_3', { replies: [() => thinking] });
    t.after(() => a.close());
    plantTree(a.bot);
    const brief = makeBrief('Lodge_3', { key: 'camp/logs', kind: 'gather', summary: 'fetch logs', resolved: { carry: { oak_log: 3 } } });
    a.transport.deliver(brief);
    await until(() => a.prompter.calls.length === 1, 'the model to be asked');
    a.transport.deliver({ type: 'task_cancel', protocol: 'task/1', key: brief.key, attempt: 1, bot: 'Lodge_3', at: Date.now(), reason: 'order cancelled' });
    await until(() => a.client.tasks.current === null, 'the runner to let go');
    answer(FELL); // the model answers after the cancel
    await sleep(100);
    assert.equal(a.transport.skillEvents.length, 0, 'no skill ran');
    assert.equal(a.bot.blockAt(TREE[0]).name, 'oak_log', 'the tree is still standing');
    assert.ok(!taskTypes(a.transport).includes('task_release'), 'a cancel is quiet: the board already took the task back');
    assert.ok(!taskTypes(a.transport).includes('task_done'));
    assert.equal(a.agent.isIdle(), true);
    assert.equal(a.prompter.calls.length, 1);
});

test('the model gives a task up with a problem code, and the release says why', async (t) => {
    const a = simAgent('Gloom_1', { replies: ['No trees anywhere near. !giveUpTask("unreachable", "no trees within reach")'] });
    t.after(() => a.close());
    const brief = makeBrief('Gloom_1', { key: 'camp/logs', kind: 'gather', summary: 'fetch logs', resolved: { carry: { oak_log: 3 } } });
    a.transport.deliver(brief);
    await until(() => taskTypes(a.transport).includes('task_release'), 'task_release');
    const release = a.transport.taskMessages.find((m) => m.type === 'task_release');
    assert.equal(release.code, 'unreachable');
    assert.match(release.detail, /the agent gave up: no trees within reach/);
    assert.ok(!taskTypes(a.transport).includes('task_done'));
    assert.ok(a.bot.chatLog.some((m) => m.trim() === 'No trees anywhere near.'), 'the words before the command are chat flavour');
});

test('a model that runs out of turns releases the task as a timeout', async (t) => {
    const a = simAgent('Gloom_2', { replies: ['Hmm, let me think.', 'Still thinking.'], brief: { maxTurns: 2 } });
    t.after(() => a.close());
    a.transport.deliver(makeBrief('Gloom_2', { key: 'camp/logs', kind: 'gather', summary: 'fetch logs', resolved: { carry: { oak_log: 3 } } }));
    await until(() => taskTypes(a.transport).includes('task_release'), 'task_release');
    const release = a.transport.taskMessages.find((m) => m.type === 'task_release');
    assert.equal(release.code, 'timeout');
    assert.match(release.detail, /not done after 2 model turns; still missing 3 oak_log/);
    assert.equal(a.prompter.calls.length, 2);
});

test('library skills are Mindcraft commands: the model calls one outside any task, and the run is recorded', async (t) => {
    const a = simAgent('Hex_1', { replies: [`Sure! ${FELL}`, ''], give: { cobblestone: 2 } });
    t.after(() => a.close());
    plantTree(a.bot);
    // Upstream's own conversation loop, a whisper from a player, the scripted model answering with a skill command.
    await a.agent.handleMessage('Steve', 'chop down that tree please');
    assert.equal(a.transport.skillEvents.length, 1);
    const inv = a.transport.skillEvents[0].invocation;
    assert.deepEqual([inv.skill.name, inv.issuer, inv.outcome.status], ['fell_tree', { role: 'worker', ref: 'mindcraft' }, 'succeeded']);
    assert.equal(a.bot.count('oak_log'), 3);
    const history = a.agent.history.getHistory().map((h) => h.content).join('\n');
    assert.match(history, /Skill fell_tree@1\.0\.0 succeeded/);

    // A player can force a command too (no model call); JSON-valued params take single quotes.
    const before = a.prompter.calls.length;
    await a.agent.handleMessage('Steve', `!skill_build_from_blocklist("[{'x':6,'y':64,'z':0,'block':'minecraft:cobblestone'}]")`);
    assert.equal(a.prompter.calls.length, before);
    assert.equal(a.bot.blockAt({ x: 6, y: 64, z: 0 }).name, 'cobblestone');
    assert.equal(a.transport.skillEvents.at(-1).invocation.skill.name, 'build_from_blocklist');
    // Bad JSON is answered as a command error, not thrown.
    const { executeCommand } = await import('../../agent/commands/index.js');
    assert.match(await executeCommand(a.agent, '!skill_build_from_blocklist("not json")'), /must be JSON/);
});

test('while a brief is held, a whisper is noted but starts no model turn', async (t) => {
    let answer;
    const thinking = new Promise((r) => { answer = r; });
    const a = simAgent('Hex_2', { replies: [() => thinking] });
    t.after(() => { answer(''); return a.close(); });
    a.transport.deliver(makeBrief('Hex_2', { key: 'camp/logs', kind: 'gather', summary: 'fetch logs', resolved: { carry: { oak_log: 3 } } }));
    await until(() => a.prompter.calls.length === 1, 'the brief loop to ask the model');
    await a.agent.handleMessage('Steve', 'come here!');
    assert.equal(a.prompter.calls.length, 1);
    assert.ok(a.agent.history.getHistory().some((h) => h.content === 'Steve: come here!'));
    assert.ok(a.bot.chatLog.some((m) => m.startsWith('Busy with a job for the overseer, Steve.')));
});

test('raw Mineflayer changes (Mindcraft\'s own library, !newAction code) are read back and reported', async (t) => {
    const a = simAgent('Hex_3', { give: { cobblestone: 4 } });
    t.after(() => a.close());
    const bot = a.bot;
    bot.addChest({ x: 1, y: 64, z: 2 }, { oak_log: 1 });
    // What src/agent/library/skills.js does: equip, placeBlock against a face, dig, open a chest, deposit, close.
    await bot.equip(bot.inventory.items().find((i) => i.name === 'cobblestone'), 'hand');
    await bot.placeBlock(bot.blockAt({ x: 5, y: 63, z: 5 }), { x: 0, y: 1, z: 0 });
    await bot.dig(bot.blockAt({ x: 7, y: 63, z: 7 }));
    const chest = await bot.openContainer(bot.blockAt({ x: 1, y: 64, z: 2 }));
    await chest.deposit(bot.registry.itemsByName.cobblestone.id, null, 2);
    await chest.close();
    await until(() => observed(a.transport).some((e) => e.type === 'container_observed'), 'the container read-back');
    await until(() => observed(a.transport).filter((e) => e.type === 'blocks_observed').flatMap((e) => e.blocks).length >= 2, 'the block read-backs');
    const blocks = observed(a.transport).filter((e) => e.type === 'blocks_observed').flatMap((e) => e.blocks);
    assert.deepEqual(blocks.find((b) => b.x === 5 && b.y === 64 && b.z === 5)?.block, 'minecraft:cobblestone');
    assert.deepEqual(blocks.find((b) => b.x === 7 && b.y === 63 && b.z === 7)?.block, 'minecraft:air');
    const c = observed(a.transport).find((e) => e.type === 'container_observed');
    assert.deepEqual([c.pos, c.container, c.items], [{ x: 1, y: 64, z: 2 }, 'chest', { oak_log: 1, cobblestone: 2 }]);
    assert.equal(bot.calls.filter((x) => x.startsWith('close')).length, 1, 'read from the closing window, not reopened');
    assert.deepEqual(a.errors, []);
});
