// The driver end to end, over real processes and real sockets: the
// overseer's dispatcher behind its bot hub on an ephemeral localhost port,
// a faction runtime (@mindcraft/bots) using this fork's driver, and one agent
// process per bot (agent_host.js) on the simulated side with a scripted model.
// Then the fleet launcher forking real faction processes: the three-bot
// rehearsal of a first live run, without the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { bots, overseerPackage, until } from './helpers.js';
import { createDriver } from '../driver.js';

const { WorldState } = await overseerPackage('@mindcraft/state');
const { TaskBoard } = await overseerPackage('@mindcraft/taskboard');
const { BotHub, Dispatcher, attachHub } = await overseerPackage('@mindcraft/dispatcher');
const { builtinRegistry } = await overseerPackage('@mindcraft/skills');
const { Warden } = await overseerPackage('@mindcraft/warden');
const { FactionControlSchema, FleetConfigSchema } = await overseerPackage('@mindcraft/contracts');

const DRIVER = fileURLToPath(new URL('../driver.js', import.meta.url));
const PAD = [
    { x: 2, y: 64, z: 0, block: 'minecraft:cobblestone' },
    { x: 3, y: 64, z: 0, block: 'minecraft:cobblestone' },
];
const SITE = {
    id: 'site',
    summary: 'a pad',
    tasks: [{ id: 'pad', kind: 'build', summary: 'cobblestone pad', zones: [{ min: { x: 2, y: 64, z: 0 }, max: { x: 3, y: 64, z: 0 } }], done: [{ type: 'blocks_match', blocks: PAD }] }],
};

function botsJson(names, server = { host: '127.0.0.1', port: 25565 }) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'overseer-bots-'));
    const file = path.join(dir, 'bots.json');
    writeFileSync(file, JSON.stringify({
        server,
        bots: names.map((username) => ({ username })),
        mindcraft: { profile: path.resolve(fileURLToPath(new URL('../../../andy.json', import.meta.url))) },
    }));
    return file;
}

async function service(t) {
    const world = new WorldState();
    const board = new TaskBoard({ world, emit: (e) => world.ingest(e) });
    const admitted = board.admit(SITE);
    if (!admitted.ok) throw new Error(admitted.errors.join('\n'));
    const links = [];
    const outcomes = [];
    const sink = [];
    const hub = new BotHub({ reconnectGraceMs: 300, commandTimeoutMs: 5_000, onEvent: (e) => links.push(e) });
    const d = new Dispatcher({
        world, board, link: hub.link, registry: builtinRegistry(),
        warden: new Warden({ home: { x: 0.5, y: 64, z: 0.5 } }),
        ports: { bot: hub.commands }, heartbeatEveryMs: 1_000,
        sink: (e) => sink.push(e), onOutcome: (o) => outcomes.push(o),
    });
    attachHub(hub, d);
    const at = await hub.listen();
    t.after(() => hub.close());
    return { world, board, hub, d, url: at.url, links, outcomes, sink };
}

test('a faction runtime with this driver: an agent process per bot, a brief done, a command answered, a clean stop', { timeout: 120_000 }, async (t) => {
    const s = await service(t);
    const config = botsJson(['Lodge_1', 'Lodge_2']);
    const reports = [];
    const runtime = new bots.FactionRuntime({
        init: FactionControlSchema.parse({
            type: 'init', faction: 'lodge', session: 'lodge.test.1', bots: [{ username: 'Lodge_1' }, { username: 'Lodge_2' }],
            server: { host: '127.0.0.1', port: 25565 }, dispatcherUrl: s.url,
            cadence: { statusEveryMs: 1_000, deltaFlushMs: 100 },
            driver: DRIVER, driverOptions: { config, sim: { give: { cobblestone: 16 } } },
        }),
        report: (m) => reports.push(m),
        driver: createDriver(),
        link: { retryMinMs: 20, retryMaxMs: 100 },
    });
    let stopped = false;
    t.after(() => (stopped ? undefined : runtime.shutdown('test over')));
    await runtime.start({ linkTimeoutMs: 5_000 });

    await runtime.login('Lodge_1');
    const online = reports.find((r) => r.type === 'bot_state' && r.bot === 'Lodge_1' && r.state !== 'logging_in');
    assert.equal(online?.state, 'online', JSON.stringify(online));
    assert.equal(typeof online.epoch, 'number');
    await until(() => s.world.bot('Lodge_1')?.online, "Lodge_1's first status", 10_000);

    // A brief crosses the link, the faction process and the IPC channel; the deltas and the claim come back.
    const assigned = await s.d.assign('Lodge_1', { key: 'site/pad' });
    if (!assigned.ok) throw new Error(assigned.errors.join('\n'));
    await until(() => s.board.task('site/pad').status === 'done', 'the pad to be done', 15_000);
    for (const b of PAD) assert.equal(s.world.blockAt(b)?.state, b.block);
    assert.deepEqual(new Set(s.outcomes.map((o) => o.action)), new Set(['start', 'heartbeat', 'complete']));

    // A Warden-style command that names a library skill reaches the agent process and is answered.
    const ran = await s.d.execute({ id: 'run-1/eat#1', issuer: { role: 'warden', ref: 'run-1' }, channel: 'bot', command: 'eat', args: {}, bot: 'Lodge_1', position: null, context: {}, issuedAt: Date.now(), result: null });
    assert.equal(ran.result.status, 'ok', JSON.stringify(ran.result));
    await until(() => s.world.skillRuns({ bot: 'Lodge_1', skill: 'eat_when_hungry' })[0], 'the skill record', 5_000);
    const refused = await s.d.execute({ id: 'run-1/dance#1', issuer: { role: 'warden', ref: 'run-1' }, channel: 'bot', command: 'dance', args: {}, bot: 'Lodge_1', position: null, context: {}, issuedAt: Date.now(), result: null });
    assert.deepEqual([refused.result.status, refused.result.detail], ['failed', 'Lodge_1 has no handler for bot command "dance"']);

    // A bot bots.json doesn't know is refused before any process starts.
    const strayConfig = botsJson(['Lodge_1'], { host: '127.0.0.1', port: 25566 });
    const strayDriver = createDriver();
    await assert.rejects(
        strayDriver({ username: 'Lodge_2', viewDistance: 'tiny', role: 'worker' }, new bots.MemoryTransport(), { faction: 'lodge', server: { host: '127.0.0.1', port: 25565 }, cadence: {}, options: { config: strayConfig, sim: true }, onError: () => {} }),
        /Lodge_2 is not in bots\.json/,
    );
    await assert.rejects(
        strayDriver({ username: 'Lodge_1', viewDistance: 'tiny', role: 'worker' }, new bots.MemoryTransport(), { faction: 'lodge', server: { host: '127.0.0.1', port: 25565 }, cadence: {}, options: { config: strayConfig, sim: true }, onError: () => {} }),
        /the fleet config says 127\.0\.0\.1:25565, bots\.json says 127\.0\.0\.1:25566/,
    );

    // A clean stop: the agent process quits its bot, reports the disconnect, and the link says goodbye.
    stopped = true;
    await runtime.shutdown('test over');
    await until(() => s.world.bot('Lodge_1')?.online === false, 'Lodge_1 offline in the world', 5_000);
    assert.ok(s.links.some((e) => e.kind === 'session_closed'), JSON.stringify(s.links.map((e) => e.kind)));
    assert.ok(!s.links.some((e) => e.kind === 'session_lost'));
});

test('a kicked bot: its agent process exits as upstream does, after reporting the disconnect; the faction carries on', { timeout: 60_000 }, async (t) => {
    const s = await service(t);
    const reports = [];
    const runtime = new bots.FactionRuntime({
        init: FactionControlSchema.parse({
            type: 'init', faction: 'gloom', session: 'gloom.test.1', bots: [{ username: 'Gloom_1' }],
            server: { host: '127.0.0.1', port: 25565 }, dispatcherUrl: s.url,
            cadence: { statusEveryMs: 1_000, deltaFlushMs: 100 },
            driver: DRIVER, driverOptions: { config: botsJson(['Gloom_1']), sim: { kickAfterMs: 4_000 } },
        }),
        report: (m) => reports.push(m),
        driver: createDriver(),
        link: { retryMinMs: 20, retryMaxMs: 100 },
    });
    t.after(() => runtime.shutdown('test over'));
    await runtime.start({ linkTimeoutMs: 5_000 });
    await runtime.login('Gloom_1');
    await until(() => s.world.bot('Gloom_1')?.online, "Gloom_1's first status", 10_000);
    const offline = await until(() => reports.find((r) => r.type === 'bot_state' && r.state === 'offline'), 'the kick', 15_000);
    assert.equal(offline.detail, 'connection ended: kicked: Kicked for flying');
    assert.equal(runtime.bots().size, 0);
    // The bot's own disconnect report crossed before its process exited; the faction's session is untouched.
    await until(() => s.world.bot('Gloom_1')?.online === false, 'Gloom_1 offline in the world', 5_000);
    assert.equal(runtime.link.state, 'connected');
    assert.ok(!s.links.some((e) => e.kind === 'session_lost'));
});

test('the fleet launcher with real faction processes and this driver: three bots log in staggered, one works a brief, all stop cleanly', { timeout: 180_000 }, async (t) => {
    const s = await service(t);
    const names = ['Lodge_1', 'Lodge_2', 'Lodge_3'];
    const config = FleetConfigSchema.parse({
        server: { connectionThrottleMs: 0 },
        dispatcher: { url: s.url },
        botsPerFaction: 3,
        loginStaggerMs: 300,
        cadence: { statusEveryMs: 1_000, deltaFlushMs: 100 },
        factions: [{ id: 'lodge' }],
    });
    const output = [];
    const launcher = new bots.FleetLauncher({
        config,
        driver: DRIVER,
        driverOptions: { config: botsJson(names), sim: { give: { cobblestone: 16 } } },
        spawn: bots.forkFaction({ log: (f, line) => output.push(`[${f}] ${line}`) }),
        stopTimeoutMs: 15_000,
    });
    let stopped = false;
    t.after(() => (stopped ? undefined : launcher.stop()));
    launcher.start();
    const up = await launcher.whenSettled(120_000);
    assert.equal(up.online, 3, output.slice(-40).join('\n'));
    const logins = up.factions[0].bots.map((b) => b.loginAt).sort((x, y) => x - y);
    for (let i = 1; i < logins.length; i++) assert.ok(logins[i] - logins[i - 1] >= 300);
    await until(() => names.every((n) => s.world.bot(n)?.online), 'all three bots to report', 10_000);

    const assigned = await s.d.assign('Lodge_2', { key: 'site/pad' });
    if (!assigned.ok) throw new Error(assigned.errors.join('\n'));
    await until(() => s.board.task('site/pad').status === 'done', 'the pad to be done', 20_000);

    stopped = true;
    await launcher.stop();
    const down = launcher.status();
    assert.deepEqual(down.factions[0].bots.map((b) => b.state), ['offline', 'offline', 'offline']);
    assert.equal(down.factions[0].state, 'stopped');
    await until(() => names.every((n) => s.world.bot(n)?.online === false), 'all three offline in the world', 5_000);
    assert.ok(!s.links.some((e) => e.kind === 'session_lost'));
});
