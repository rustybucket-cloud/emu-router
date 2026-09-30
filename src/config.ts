import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME_DIR = process.env.EMU_ROUTER_HOME ?? path.join(os.homedir(), '.emu-router');
export const CONFIG_PATH = path.join(HOME_DIR, 'config.json');
export const LOG_DIR = path.join(HOME_DIR, 'logs');
export const APK_CACHE_DIR = path.join(HOME_DIR, 'apk-cache');

export const DAEMON_PORT = Number(process.env.EMU_ROUTER_PORT ?? 7777);
export const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

export type Config = {
  /** Most pool emulators allowed to run at once. */
  maxRunning: number;
  /** AVD whose hardware and system image new pool emulators copy. Null picks one automatically. */
  templateAvd: string | null;
  /** AVDs the router shows but never hands out. */
  excludedAvds: string[];
  /** Run emulators without a window. */
  headless: boolean;
  /** Shut down emulators the router started after this long unused. 0 keeps them warm. */
  idleShutdownMinutes: number;
  /** Extra flags passed to every `emulator` launch. */
  emulatorArgs: string[];
  /** First Metro port to hand out; later servers count up from here. */
  metroBasePort: number;
};

const DEFAULTS: Config = {
  maxRunning: 2,
  templateAvd: null,
  excludedAvds: [],
  headless: false,
  idleShutdownMinutes: 0,
  emulatorArgs: [],
  metroBasePort: 8081,
};

export function loadConfig(): Config {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config: Config) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}
