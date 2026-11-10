// `npm start` in overseer mode (settings.overseer, off by default): instead
// of the MindServer and one agent per profile, run the overseer's fleet
// launcher with this fork's driver. Equivalent to
//
//   MINDCRAFT_BOTS_CONFIG=bots.json node <overseer>/bots/dist/cli.js fleet fleet.json --driver src/overseer/driver.js
//
// settings.overseer: true, or { fleet: "./fleet.json", bots: "./bots.json" }.
// The fleet config is the overseer's (FleetConfigSchema: factions, the
// dispatcher's URL, the login stagger); bots.json is this fork's (OVERSEER.md).
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { FORK_ROOT, loadBotsConfig } from './config.js';

export async function runOverseer(settings) {
    const opts = typeof settings.overseer === 'object' && settings.overseer !== null ? settings.overseer : {};
    const fleet = path.resolve(FORK_ROOT, opts.fleet ?? process.env.OVERSEER_FLEET ?? 'fleet.json');
    const botsConfig = path.resolve(FORK_ROOT, opts.bots ?? process.env.MINDCRAFT_BOTS_CONFIG ?? 'bots.json');
    loadBotsConfig(botsConfig); // refuse to start on a bad bots.json, before any process is forked
    let cli;
    try {
        cli = path.join(path.dirname(fileURLToPath(import.meta.resolve('@mindcraft/bots'))), 'cli.js');
    } catch {
        throw new Error('@mindcraft/bots is not linked: run `npm run overseer:link` (OVERSEER.md)');
    }
    const driver = fileURLToPath(new URL('./driver.js', import.meta.url));
    console.log(`Overseer mode: fleet ${fleet}, bots ${botsConfig}`);
    const child = spawn(process.execPath, [cli, 'fleet', fleet, '--driver', driver], {
        cwd: FORK_ROOT,
        stdio: 'inherit',
        env: { ...process.env, MINDCRAFT_BOTS_CONFIG: botsConfig },
    });
    process.on('SIGINT', () => {}); // Ctrl-C reaches the launcher too; it stops the fleet and exits, then so do we
    const code = await new Promise((resolve) => child.on('exit', (c, signal) => resolve(c ?? (signal ? 1 : 0))));
    process.exit(code);
}
