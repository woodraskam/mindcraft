// Link this checkout to a built mindcraft-overseer checkout's `bots` package:
// node_modules/@mindcraft/bots -> <overseer>/bots (a junction on Windows, a
// symlink elsewhere). See OVERSEER.md, "The @mindcraft/bots dependency".
//
//   node src/overseer/link.js [<overseer checkout>]     (or MINDCRAFT_OVERSEER=<path>)
//   node src/overseer/link.js --if-present              (postinstall: link only if the checkout exists)
//
// It is deliberately not an npm dependency: @mindcraft/bots and its workspace
// siblings (@mindcraft/contracts, ...) are not published, so npm must never
// try to resolve their dependencies from the registry. Node follows the link to
// its real path and finds them in the overseer checkout's own node_modules.
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const FORK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function overseerCheckout(arg) {
    return path.resolve(FORK_ROOT, arg || process.env.MINDCRAFT_OVERSEER || '../mindcraft-overseer');
}

export function linkBots(checkout, { ifPresent = false, log = console.log } = {}) {
    const target = path.join(checkout, 'bots');
    const built = path.join(target, 'dist', 'index.js');
    if (!existsSync(built)) {
        if (ifPresent) return null;
        throw new Error(`${built} not found: build the overseer checkout first (npm install && npm run build in ${checkout})`);
    }
    const link = path.join(FORK_ROOT, 'node_modules', '@mindcraft', 'bots');
    mkdirSync(path.dirname(link), { recursive: true });
    let present = null;
    try { present = lstatSync(link); } catch { /* not there */ }
    if (present) {
        if (!present.isSymbolicLink()) throw new Error(`${link} exists and is not a link; remove it first`);
        if (path.resolve(path.dirname(link), readlinkSync(link)) === path.resolve(target)) {
            log(`@mindcraft/bots already linked to ${target}`);
            return link;
        }
        rmSync(link, { force: true, recursive: false });
    }
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    log(`linked node_modules/@mindcraft/bots -> ${target}`);
    return link;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const ifPresent = args.includes('--if-present');
    const where = args.find(a => !a.startsWith('--'));
    try {
        linkBots(overseerCheckout(where), { ifPresent });
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}
