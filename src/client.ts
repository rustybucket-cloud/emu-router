import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DAEMON_URL, HOME_DIR } from './config.ts';
import type { AppTarget, Lease } from './pool.ts';

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL('./cli.ts', import.meta.url));

export function log(message: string) {
  console.log(`\x1b[35m[emu-router]\x1b[0m ${message}`);
}

export async function api<T = any>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${DAEMON_URL}${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.error ?? `HTTP ${res.status}`), { status: res.status });
  return json as T;
}

async function daemonIsUp() {
  try {
    await api('GET', '/api/state');
    return true;
  } catch {
    return false;
  }
}

/** Starts the daemon in the background if it isn't already running. */
export async function ensureDaemon() {
  if (await daemonIsUp()) return;

  fs.mkdirSync(HOME_DIR, { recursive: true });
  const out = fs.openSync(path.join(HOME_DIR, 'daemon.log'), 'a');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI_PATH, 'daemon'], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  fs.closeSync(out);

  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await daemonIsUp()) return;
  }
  throw new Error(`Daemon didn't start; see ${path.join(HOME_DIR, 'daemon.log')}`);
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Expo Go is versioned per SDK, e.g. expo@54.x needs Expo Go for "54.0.0". */
function expoSdkVersion(cwd: string): string | null {
  try {
    const expoPkg = createRequire(path.join(cwd, 'package.json')).resolve('expo/package.json');
    return `${readJson(expoPkg).version.split('.')[0]}.0.0`;
  } catch {
    return null;
  }
}

async function expoSlug(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('npx', ['expo', 'config', '--json', '--type', 'public'], { cwd, timeout: 60_000 });
    return JSON.parse(stdout).slug;
  } catch {
    const slug = readJson(path.join(cwd, 'app.json'))?.expo?.slug;
    if (!slug) throw new Error('Could not read the app slug; set EMU_ROUTER_URL instead');
    return slug;
  }
}

/** The debug APK from the last `expo run:android`, so fresh emulators can get the dev build without a rebuild. */
function localDevBuild(cwd: string): AppTarget['apk'] {
  const dir = path.join(cwd, 'android', 'app', 'build', 'outputs', 'apk', 'debug');
  const meta = readJson(path.join(dir, 'output-metadata.json'));
  const file = meta?.elements?.[0]?.outputFile;
  if (!meta?.applicationId || !file || !fs.existsSync(path.join(dir, file))) return null;
  return { path: path.join(dir, file), packageId: meta.applicationId };
}

/** Works out the deep link that loads this project on a device, over `adb reverse` to localhost. */
async function resolveApp(cwd: string, expoArgs: string[], port: number): Promise<AppTarget> {
  const override = process.env.EMU_ROUTER_URL;
  if (override) return { url: override.replaceAll('{port}', String(port)), expoGoSdk: null, apk: null };

  const pkg = readJson(path.join(cwd, 'package.json')) ?? {};
  const hasDevClient = Boolean(pkg.dependencies?.['expo-dev-client'] ?? pkg.devDependencies?.['expo-dev-client']);
  const devClient = expoArgs.includes('--dev-client') || (hasDevClient && !expoArgs.includes('--go'));

  if (devClient) {
    const metro = encodeURIComponent(`http://127.0.0.1:${port}`);
    return { url: `exp+${await expoSlug(cwd)}://expo-development-client/?url=${metro}`, expoGoSdk: null, apk: localDevBuild(cwd) };
  }
  return { url: `exp://127.0.0.1:${port}`, expoGoSdk: expoSdkVersion(cwd), apk: null };
}

async function waitForMetro(port: number, gaveUp: () => boolean) {
  while (!gaveUp()) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`);
      if ((await res.text()).includes('packager-status:running')) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error('Expo exited before Metro started');
}

/** Prints lease progress (assigned, booting, opened, errors) as it changes. */
function watchLease(id: string) {
  let last = '';
  const timer = setInterval(async () => {
    try {
      const lease = await api<Lease & { serial: string | null; activity: string | null; running: number; cap: number }>('GET', `/api/leases/${id}`);
      const where = lease.avd ? `${lease.avd} (${lease.serial})` : '';
      const line =
        lease.error ??
        (lease.status === 'waiting'
          ? lease.running >= lease.cap
            ? `All ${lease.cap} emulator slots are in use; queued. Raise the cap with "emu-router cap ${lease.cap + 1}" or in the dashboard.`
            : 'Waiting for a free emulator…'
          : lease.status === 'booting'
            ? `Booting ${where}…`
            : lease.activity
              ? `${lease.activity} on ${where}…`
              : lease.opened
                ? `Opened on ${where}`
                : `Assigned ${where}`);
      if (line !== last) log(line);
      last = line;
    } catch {
      clearInterval(timer);
    }
  }, 1_500);
  return timer;
}

export async function runStart(expoArgs: string[]) {
  if (expoArgs.some((arg) => arg === '--port' || arg === '-p' || arg.startsWith('--port='))) {
    throw new Error('emu-router assigns the Metro port itself; drop --port');
  }
  const cwd = process.cwd();
  await ensureDaemon();

  const project = readJson(path.join(cwd, 'package.json'))?.name ?? path.basename(cwd);
  const lease = await api<Lease>('POST', '/api/leases', { project, cwd, pid: process.pid });
  log(`Metro on port ${lease.metroPort} · dashboard ${DAEMON_URL}`);
  log(`Open the app from the dashboard, not Expo's "a" key (that picks the first device).`);

  const heartbeat = setInterval(() => api('POST', `/api/leases/${lease.id}/heartbeat`).catch(() => {}), 5_000);
  const watcher = watchLease(lease.id);

  const expo = spawn('npx', ['expo', 'start', '--port', String(lease.metroPort), ...expoArgs], { cwd, stdio: 'inherit' });

  // Ctrl+C reaches Expo too; release the emulator once Expo has exited.
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => expo.kill('SIGTERM'));
  expo.on('exit', async (code, signal) => {
    clearInterval(heartbeat);
    clearInterval(watcher);
    await api('DELETE', `/api/leases/${lease.id}`).catch(() => {});
    process.exit(code ?? (signal ? 1 : 0));
  });

  try {
    await waitForMetro(lease.metroPort, () => expo.exitCode !== null || expo.signalCode !== null);
    await api('POST', `/api/leases/${lease.id}/app`, await resolveApp(cwd, expoArgs, lease.metroPort));
  } catch (err) {
    log(`\x1b[31m${(err as Error).message}\x1b[0m`);
  }
}
