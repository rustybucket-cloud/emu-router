import { execFile } from 'node:child_process';
import path from 'node:path';
import { api, ensureDaemon, log, runStart } from './client.ts';
import { DAEMON_PORT, DAEMON_URL } from './config.ts';
import type { Emulator, Lease } from './pool.ts';

const USAGE = `emu-router — route Expo dev servers to Android emulators

  emu-router start [expo args]   Start Expo on a free emulator (boots or creates one if needed)
  emu-router ui                  Open the dashboard
  emu-router stop [--port <n> | --emulator <serial|avd>]
                                 Stop a session (default: the one started in this directory)
  emu-router status              List emulators and sessions
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

type State = { running: number; config: { maxRunning: number }; emulators: Emulator[]; leases: Lease[] };

function serialOf(state: State, lease: Lease) {
  return state.emulators.find((e) => e.avd === lease.avd)?.serial ?? null;
}

function describeLease(state: State, l: Lease) {
  const where = l.avd ? `${serialOf(state, l) ?? l.avd}` : '';
  return `:${l.metroPort}  ${l.status.padEnd(7)} ${where.padEnd(14)} pid ${String(l.pid ?? '?').padEnd(7)} ${l.cwd}`;
}

async function printStatus() {
  await ensureDaemon();
  const state = await api<State>('GET', '/api/state');
  console.log(`Running ${state.running}/${state.config.maxRunning}\n`);
  for (const e of state.emulators) {
    const lease = state.leases.find((l) => l.id === e.leaseId);
    const tags = [e.inPool ? '' : 'excluded', lease ? `→ ${lease.project} :${lease.metroPort}` : '', e.error ?? ''].filter(Boolean);
    console.log(`  ${e.status.padEnd(9)} ${e.avd.padEnd(24)} ${(e.serial ?? '').padEnd(14)} ${tags.join('  ')}`);
  }
  if (state.leases.length) {
    console.log('\nSessions:');
    for (const l of state.leases) console.log(`  ${describeLease(state, l)}`);
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const value = args[i].includes('=') ? args[i].slice(args[i].indexOf('=') + 1) : args[i + 1];
  if (!value) throw new Error(`--${name} needs a value`);
  return value;
}

/** Picks the session to stop: by --port, by --emulator, or else the one started in (or above) this directory. */
function findLeases(state: State, args: string[]): Lease[] {
  const port = flag(args, 'port');
  const emulator = flag(args, 'emulator');
  if (port) return state.leases.filter((l) => l.metroPort === Number(port));
  if (emulator) return state.leases.filter((l) => l.avd === emulator || (l.avd && serialOf(state, l) === emulator));

  // Longest match wins, so a worktree nested inside the main checkout doesn't also match the checkout's session.
  const cwd = process.cwd();
  const owners = state.leases.filter((l) => l.cwd && (cwd === l.cwd || cwd.startsWith(l.cwd + path.sep)));
  const deepest = Math.max(...owners.map((l) => l.cwd.length));
  return owners.filter((l) => l.cwd.length === deepest);
}

async function stopSession(args: string[]) {
  const state = await api<State>('GET', '/api/state').catch(() => null);
  if (!state) throw new Error("The daemon isn't running, so there are no sessions");

  const matches = findLeases(state, args);
  if (matches.length === 0) {
    const hint = args.length ? '' : ` in ${process.cwd()}; pass --port or --emulator`;
    throw new Error(`No session found${hint}. See "emu-router status".`);
  }
  if (matches.length > 1) {
    throw new Error(`${matches.length} sessions match; pick one with --port:\n${matches.map((l) => `  ${describeLease(state, l)}`).join('\n')}`);
  }

  const [lease] = matches;
  // The session's CLI stops Expo on SIGTERM and then releases the lease itself.
  let signalled = false;
  if (lease.pid !== null) {
    try {
      process.kill(lease.pid, 'SIGTERM');
      signalled = true;
    } catch {}
  }
  if (!signalled) {
    await api('DELETE', `/api/leases/${lease.id}`);
    log(`Released session on :${lease.metroPort}`);
    return;
  }

  for (let i = 0; i < 75; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const gone = await api('GET', `/api/leases/${lease.id}`).then(
      () => false,
      (err) => err.status === 404,
    );
    if (gone) {
      log(`Stopped session on :${lease.metroPort} (pid ${lease.pid})`);
      return;
    }
  }
  throw new Error(`Sent SIGTERM to pid ${lease.pid}, but its session on :${lease.metroPort} is still up`);
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
    case 'stop':
      await stopSession(rest);
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
