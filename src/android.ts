import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { LOG_DIR } from './config.ts';

const execFileAsync = promisify(execFile);

export const SDK_ROOT =
  process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? path.join(os.homedir(), 'Library', 'Android', 'sdk');
export const AVD_HOME = process.env.ANDROID_AVD_HOME ?? path.join(os.homedir(), '.android', 'avd');

const ADB = path.join(SDK_ROOT, 'platform-tools', 'adb');
const EMULATOR = path.join(SDK_ROOT, 'emulator', 'emulator');
const SDKMANAGER = path.join(SDK_ROOT, 'cmdline-tools', 'latest', 'bin', 'sdkmanager');

/** AVDs the router creates are named with this prefix, which also marks them as safe to delete. */
export const MANAGED_PREFIX = 'emu-router-';

const FIRST_EMULATOR_PORT = 5554;
const LAST_EMULATOR_PORT = 5584;

async function adb(args: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await execFileAsync(ADB, args, { timeout });
  return stdout;
}

export function listAvds(): string[] {
  if (!fs.existsSync(AVD_HOME)) return [];
  return fs
    .readdirSync(AVD_HOME)
    .filter((file) => file.endsWith('.ini'))
    .map((file) => file.slice(0, -'.ini'.length))
    .sort();
}

// `emu avd name` goes through the emulator console, so cache it per serial.
const avdNameBySerial = new Map<string, string>();

/** Running emulators by AVD name, plus every emulator serial adb can see. */
export async function runningEmulators(): Promise<{ byAvd: Map<string, string>; serials: string[] }> {
  const serials = (await adb(['devices']))
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((serial): serial is string => Boolean(serial?.startsWith('emulator-')));

  for (const serial of avdNameBySerial.keys()) {
    if (!serials.includes(serial)) avdNameBySerial.delete(serial);
  }

  const byAvd = new Map<string, string>();
  for (const serial of serials) {
    let name = avdNameBySerial.get(serial);
    if (!name) {
      try {
        name = (await adb(['-s', serial, 'emu', 'avd', 'name'], 5_000)).split(/\r?\n/)[0].trim();
      } catch {
        continue;
      }
      if (!name || name === 'OK' || name.startsWith('KO')) continue;
      avdNameBySerial.set(serial, name);
    }
    byAvd.set(name, serial);
  }
  return { byAvd, serials };
}

export function freeEmulatorPort(usedSerials: Iterable<string>): number | null {
  const used = new Set(usedSerials);
  for (let port = FIRST_EMULATOR_PORT; port <= LAST_EMULATOR_PORT; port += 2) {
    if (!used.has(`emulator-${port}`)) return port;
  }
  return null;
}

export function logPath(avd: string) {
  return path.join(LOG_DIR, `${avd}.log`);
}

/** Launches an emulator that outlives the daemon, so restarting the daemon doesn't kill devices. */
export function bootEmulator(avd: string, port: number, opts: { headless: boolean; emulatorArgs: string[] }): ChildProcess {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const log = fs.openSync(logPath(avd), 'w');
  const args = ['-avd', avd, '-port', String(port), '-no-boot-anim', ...(opts.headless ? ['-no-window'] : []), ...opts.emulatorArgs];
  const child = spawn(EMULATOR, args, { detached: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  child.unref();
  return child;
}

export async function isBooted(serial: string): Promise<boolean> {
  try {
    return (await adb(['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], 5_000)).trim() === '1';
  } catch {
    return false;
  }
}

export async function killEmulator(serial: string) {
  await adb(['-s', serial, 'emu', 'kill']);
}

export async function reverse(serial: string, port: number) {
  await adb(['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
}

export async function removeReverse(serial: string, port: number) {
  await adb(['-s', serial, 'reverse', '--remove', `tcp:${port}`]);
}

export async function hasPackage(serial: string, pkg: string): Promise<boolean> {
  try {
    return (await adb(['-s', serial, 'shell', 'pm', 'path', pkg])).includes('package:');
  } catch {
    return false;
  }
}

export async function installApk(serial: string, apkPath: string) {
  await adb(['-s', serial, 'install', '-r', apkPath], 5 * 60_000);
}

export async function openUrl(serial: string, url: string) {
  let out: string;
  try {
    out = await adb(['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${url}'`]);
  } catch (err) {
    out = String((err as { stdout?: string }).stdout ?? (err as Error).message);
  }
  if (/unable to resolve/i.test(out)) {
    const scheme = url.split(':')[0];
    throw new Error(`No installed app handles ${scheme}:// — install the dev build (npx expo run:android --device <avd>)`);
  }
  if (/Error/.test(out)) throw new Error(out.trim());
}

function parseIni(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) entries[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return entries;
}

function formatIni(entries: Record<string, string>) {
  return Object.entries(entries).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}

function readAvdConfig(avd: string) {
  const pointer = parseIni(fs.readFileSync(path.join(AVD_HOME, `${avd}.ini`), 'utf8'));
  const dir = pointer.path ?? path.join(AVD_HOME, `${avd}.avd`);
  return { pointer, config: parseIni(fs.readFileSync(path.join(dir, 'config.ini'), 'utf8')) };
}

async function installSystemImage(sysdir: string) {
  if (!fs.existsSync(SDKMANAGER)) {
    throw new Error(`System image ${sysdir} is missing and sdkmanager isn't installed (Android Studio → SDK Manager → Command-line Tools)`);
  }
  const pkg = sysdir.replace(/\/+$/, '').split('/').join(';');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(SDKMANAGER, [pkg], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end('y\n'.repeat(20)); // accept licenses
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`sdkmanager exited with code ${code}`))));
  });
}

/**
 * Creates a fresh AVD with the template's hardware profile and system image.
 * Only config is copied, not disk images, so the new device starts clean and costs no copy time.
 */
export async function createAvd(name: string, template: string) {
  const { pointer, config } = readAvdConfig(template);

  const sysdir = config['image.sysdir.1'];
  if (!sysdir) throw new Error(`${template} has no system image configured`);
  if (!fs.existsSync(path.join(SDK_ROOT, sysdir))) await installSystemImage(sysdir);

  const dir = path.join(AVD_HOME, `${name}.avd`);
  config.AvdId = name;
  config['avd.ini.displayname'] = name;
  // avdmanager would also create an sdcard image; skip it rather than depend on mksdcard.
  config['hw.sdCard'] = 'no';
  delete config['sdcard.size'];
  delete config['sdcard.path'];

  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'config.ini'), formatIni(config));
  fs.writeFileSync(
    path.join(AVD_HOME, `${name}.ini`),
    formatIni({
      'avd.ini.encoding': 'UTF-8',
      path: dir,
      'path.rel': path.relative(path.dirname(AVD_HOME), dir),
      target: pointer.target ?? config.target ?? '',
    }),
  );
}

export function deleteAvd(name: string) {
  fs.rmSync(path.join(AVD_HOME, `${name}.avd`), { recursive: true, force: true });
  fs.rmSync(path.join(AVD_HOME, `${name}.ini`), { force: true });
}

export function nextManagedName(existing: Iterable<string>): string {
  const taken = new Set(existing);
  let n = 1;
  while (taken.has(`${MANAGED_PREFIX}${n}`)) n++;
  return `${MANAGED_PREFIX}${n}`;
}
