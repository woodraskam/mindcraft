// Read-backs for world changes made through raw Mineflayer: Mindcraft's
// library (src/agent/library/skills.js), its modes, the pathfinder's own
// digging and scaffolding, and any !newAction code. The rule from
// @mindcraft/bots: a change made outside the port must be reported with
// client.reportChangedBlocks / client.reportContainer, or the world model
// never hears of it. Rather than edit every call site in upstream code, the
// bot's world-changing methods are wrapped once, on this bot instance:
//
//   dig(block)              -> the block, read back after the dig settles
//   placeBlock(ref, face)   -> ref + face
//   activateBlock(block)    -> the block (doors, levers, tilling), now and again shortly after
//   activateItem()          -> with a bucket, flint and steel, fire charge or bone meal held:
//                              the block at the cursor and its neighbours, now and shortly after
//   openBlock/openContainer -> the container, with the contents its window shows when it closes
//
// What is reported is always what the bot's chunk view shows afterwards,
// never what the call meant to do. The port's own actions go through the
// same methods, so they are reported twice; identical read-backs merge in
// the emitter's flush window (blocks) or repeat the same fact (containers).

const WORLD_CHANGING_ITEMS = /(^|_)bucket$|^flint_and_steel$|^fire_charge$|^bone_meal$/;
const NEIGHBOURS = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

const cell = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

export function installReadBacks(bot, client, { againMs = 300, onError = (err) => console.error('[overseer] read-back:', err) } = {}) {
    const restore = [];
    const timers = new Set();
    const open = new Map(); // window -> container position

    const report = (positions) => {
        try { client.reportChangedBlocks(positions); } catch (err) { onError(err); }
    };
    const reportNowAndLater = (positions) => {
        report(positions);
        const t = setTimeout(() => { timers.delete(t); report(positions); }, againMs);
        t.unref?.();
        timers.add(t);
    };
    const wrap = (name, make) => {
        if (typeof bot[name] !== 'function') return;
        const original = bot[name];
        const had = Object.prototype.hasOwnProperty.call(bot, name);
        bot[name] = make(original);
        restore.push(() => { if (had) bot[name] = original; else delete bot[name]; });
    };

    wrap('dig', (dig) => async function (block, ...rest) {
        const pos = cell(block.position);
        try { return await dig.call(bot, block, ...rest); } finally { report([pos]); }
    });

    wrap('placeBlock', (placeBlock) => async function (reference, face, ...rest) {
        const pos = cell({ x: reference.position.x + face.x, y: reference.position.y + face.y, z: reference.position.z + face.z });
        try { return await placeBlock.call(bot, reference, face, ...rest); } finally { report([pos]); }
    });

    wrap('activateBlock', (activateBlock) => async function (block, ...rest) {
        const pos = cell(block.position);
        try { return await activateBlock.call(bot, block, ...rest); } finally { reportNowAndLater([pos]); }
    });

    wrap('activateItem', (activateItem) => async function (...args) {
        const held = bot.heldItem?.name;
        const target = held && WORLD_CHANGING_ITEMS.test(held) ? bot.blockAtCursor?.(5) : null;
        try { return await activateItem.call(bot, ...args); } finally {
            if (target) {
                const c = cell(target.position);
                reportNowAndLater(NEIGHBOURS.map(([dx, dy, dz]) => ({ x: c.x + dx, y: c.y + dy, z: c.z + dz })));
            }
        }
    });

    const reportWindow = (window) => {
        const pos = open.get(window);
        if (!pos) return;
        open.delete(window);
        client.reportContainer(pos, window).catch((err) => {
            if (err?.code !== 'no_container') onError(err); // crafting tables, furnaces: not containers to the world model
        });
    };
    const opener = (openFn) => async function (block, ...rest) {
        const window = await openFn.call(bot, block, ...rest);
        if (window && block?.position && !open.has(window)) {
            open.set(window, cell(block.position));
            if (typeof window.close === 'function') {
                const close = window.close;
                window.close = function (...a) {
                    reportWindow(window); // the contents as the window shows them when the bot lets go
                    return close.apply(this, a);
                };
            }
        }
        return window;
    };
    wrap('openBlock', opener);
    wrap('openContainer', opener);
    // Windows the server closes (the chest was broken, the bot moved away) never pass through window.close.
    const onWindowClose = (window) => reportWindow(window);
    bot.on?.('windowClose', onWindowClose);

    return function uninstall() {
        for (const r of restore.reverse()) r();
        for (const t of timers) clearTimeout(t);
        timers.clear();
        bot.removeListener?.('windowClose', onWindowClose);
    };
}
