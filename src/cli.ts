import { execFile } from 'node:child_process';
import { api, ensureDaemon, log, runStart } from './client.ts';
import { DAEMON_PORT, DAEMON_URL } from './config.ts';
import type { Emulator, Lease } from './pool.ts';

const USAGE = `emu-router — route Expo dev servers to Android emulators

  emu-router start [expo args]   Start Expo on a free emulator (boots or creates one if needed)
  emu-router ui                  Open the dashboard
  emu-router status              List emulators and leases
  emu-router cap <n>             Set the most emulators allowed to run at once
  emu-router daemon              Run the daemon in the foreground
  emu-router shutdown            Stop the daemon (emulators keep running)
`;

async function runDaemon() {
  const { Pool } = await import('./pool.ts');
  const { startServer } = await import('./server.ts');
  const pool = new Pool();
  try {
    await startServer(pool, DAEMON_PORT);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`Port ${DAEMON_PORT} is in use; is another emu-router daemon running?`);
      process.exit(1);
    }
    throw err;
  }
  await pool.start();
  console.log(`emu-router daemon listening on ${DAEMON_URL}`);
}

async function printStatus() {
  await ensureDaemon();
  const state = await api<{ running: number; config: { maxRunning: number }; emulators: Emulator[]; leases: Lease[] }>('GET', '/api/state');
  console.log(`Running ${state.running}/${state.config.maxRunning}\n`);
  for (const e of state.emulators) {
    const lease = state.leases.find((l) => l.id === e.leaseId);
    const tags = [e.inPool ? '' : 'excluded', lease ? `→ ${lease.project} :${lease.metroPort}` : '', e.error ?? ''].filter(Boolean);
    console.log(`  ${e.status.padEnd(9)} ${e.avd.padEnd(24)} ${(e.serial ?? '').padEnd(14)} ${tags.join('  ')}`);
  }
  const waiting = state.leases.filter((l) => l.status === 'waiting');
  if (waiting.length) console.log(`\nQueued: ${waiting.map((l) => l.project).join(', ')}`);
}

const [command, ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case 'start':
      await runStart(rest);
      break;
    case 'daemon':
      await runDaemon();
      break;
    case 'ui':
      await ensureDaemon();
      execFile('open', [DAEMON_URL]);
      log(DAEMON_URL);
      break;
    case 'status':
      await printStatus();
      break;
    case 'cap': {
      const n = Number(rest[0]);
      await ensureDaemon();
      await api('PUT', '/api/config', { maxRunning: n });
      log(`Cap set to ${n}`);
      break;
    }
    case 'shutdown':
      await api('POST', '/api/shutdown').catch(() => {});
      log('Daemon stopped');
      break;
    default:
      console.log(USAGE);
      process.exit(command && command !== 'help' ? 1 : 0);
  }
} catch (err) {
  console.error(`\x1b[31m${(err as Error).message}\x1b[0m`);
  process.exit(1);
}
