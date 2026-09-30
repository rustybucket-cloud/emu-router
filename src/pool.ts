import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import * as android from './android.ts';
import { loadConfig, saveConfig, type Config } from './config.ts';
import { EXPO_GO_PACKAGE, ensureExpoGoApk } from './expo-go.ts';

export type EmulatorStatus = 'creating' | 'stopped' | 'booting' | 'idle' | 'leased' | 'stopping' | 'error';

export type Emulator = {
  avd: string;
  serial: string | null;
  status: EmulatorStatus;
  statusSince: number;
  inPool: boolean;
  /** Created by the router (and so deletable from the UI). */
  managed: boolean;
  /** Booted by the router, so the router may also shut it down. */
  startedByRouter: boolean;
  leaseId: string | null;
  /** Short-lived work in progress, e.g. installing Expo Go. */
  activity: string | null;
  error: string | null;
};

export type LeaseStatus = 'waiting' | 'booting' | 'ready';

export type AppTarget = {
  url: string;
  /** Expo Go SDK to install if missing, e.g. "54.0.0". */
  expoGoSdk: string | null;
  /** A locally built dev client to install if missing. */
  apk: { path: string; packageId: string } | null;
};

export type Lease = {
  id: string;
  project: string;
  cwd: string;
  pid: number | null;
  metroPort: number;
  avd: string | null;
  status: LeaseStatus;
  app: AppTarget | null;
  opened: boolean;
  error: string | null;
  createdAt: number;
  heartbeatAt: number;
};

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const LEASE_TTL_MS = 30_000;
const BOOT_TIMEOUT_MS = 4 * 60_000;
const TICK_MS = 3_000;

// Statuses that hold a slot under the running cap.
const RUNNING: EmulatorStatus[] = ['creating', 'booting', 'idle', 'leased', 'stopping'];

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

export class Pool extends EventEmitter {
  config: Config = loadConfig();
  /** Set when automatic AVD creation fails; blocks further automatic creation until dismissed. */
  poolError: string | null = null;

  private emulators = new Map<string, Emulator>();
  private leases = new Map<string, Lease>();
  private bootDeadlines = new Map<string, number>();
  private launching = new Set<string>();
  private lastSnapshot = '';
  private queue: Promise<unknown> = Promise.resolve();

  async start() {
    await this.run(() => this.sync());
    setInterval(() => this.run(() => this.sync()).catch((err) => console.error('[pool] sync failed:', err)), TICK_MS);
  }

  snapshot() {
    return {
      config: this.config,
      poolError: this.poolError,
      running: this.runningCount(),
      emulators: [...this.emulators.values()],
      leases: [...this.leases.values()].sort((a, b) => a.createdAt - b.createdAt),
    };
  }

  // ---- Public operations. Each runs serialized so state changes never interleave. ----

  requestLease(input: { project: string; cwd: string; pid: number | null }) {
    return this.run(async () => {
      const now = Date.now();
      const lease: Lease = {
        id: crypto.randomUUID(),
        project: input.project,
        cwd: input.cwd,
        pid: input.pid,
        metroPort: await this.allocateMetroPort(),
        avd: null,
        status: 'waiting',
        app: null,
        opened: false,
        error: null,
        createdAt: now,
        heartbeatAt: now,
      };
      this.leases.set(lease.id, lease);
      this.schedule();
      this.changed();
      return lease;
    });
  }

  getLease(id: string) {
    const lease = this.leases.get(id);
    if (!lease) throw new HttpError(404, 'Lease not found');
    const emulator = lease.avd ? this.emulators.get(lease.avd) : undefined;
    return {
      ...lease,
      serial: emulator?.serial ?? null,
      activity: emulator?.activity ?? null,
      running: this.runningCount(),
      cap: this.config.maxRunning,
    };
  }

  heartbeat(id: string) {
    return this.run(() => {
      this.getLease(id);
      this.leases.get(id)!.heartbeatAt = Date.now();
    });
  }

  setApp(id: string, app: AppTarget) {
    return this.run(() => {
      const lease = this.leases.get(id);
      if (!lease) throw new HttpError(404, 'Lease not found');
      lease.app = app;
      this.launch(lease);
      this.changed();
    });
  }

  reopen(id: string) {
    return this.run(() => {
      const lease = this.leases.get(id);
      if (!lease) throw new HttpError(404, 'Lease not found');
      lease.opened = false;
      this.launch(lease);
      this.changed();
    });
  }

  release(id: string) {
    return this.run(() => {
      this.releaseLease(id);
      this.schedule();
      this.changed();
    });
  }

  updateConfig(patch: Partial<Config>) {
    return this.run(() => {
      if (patch.maxRunning !== undefined && (!Number.isInteger(patch.maxRunning) || patch.maxRunning < 1 || patch.maxRunning > 16)) {
        throw new HttpError(400, 'maxRunning must be between 1 and 16');
      }
      this.config = { ...this.config, ...patch };
      saveConfig(this.config);
      this.poolError = null;
      this.schedule();
      this.trimIdle();
      this.changed();
    });
  }

  setInPool(avd: string, inPool: boolean) {
    return this.run(() => {
      this.emulator(avd);
      const excluded = new Set(this.config.excludedAvds);
      if (inPool) excluded.delete(avd);
      else excluded.add(avd);
      this.config = { ...this.config, excludedAvds: [...excluded] };
      saveConfig(this.config);
      this.emulator(avd).inPool = inPool;
      this.schedule();
      this.changed();
    });
  }

  startEmulator(avd: string) {
    return this.run(() => {
      const e = this.emulator(avd);
      if (e.status !== 'stopped' && e.status !== 'error') throw new HttpError(409, `${avd} is ${e.status}`);
      if (e.inPool && this.runningCount() >= this.config.maxRunning) {
        throw new HttpError(409, `At the cap of ${this.config.maxRunning} running emulators`);
      }
      this.boot(e);
      this.changed();
    });
  }

  stopEmulator(avd: string) {
    return this.run(() => {
      const e = this.emulator(avd);
      if (!e.serial || e.status === 'stopped' || e.status === 'stopping') throw new HttpError(409, `${avd} is not running`);
      this.stop(e);
      this.changed();
    });
  }

  addEmulator() {
    return this.run(() => {
      const e = this.createEmulator();
      if (!e) throw new HttpError(500, this.poolError ?? 'Could not create an emulator');
      this.changed();
      return e;
    });
  }

  deleteEmulator(avd: string) {
    return this.run(() => {
      const e = this.emulator(avd);
      if (!e.managed) throw new HttpError(403, 'Only emulators created by emu-router can be deleted here');
      if (e.status !== 'stopped' && e.status !== 'error') throw new HttpError(409, `Stop ${avd} first`);
      android.deleteAvd(avd);
      this.emulators.delete(avd);
      this.changed();
    });
  }

  clearErrors() {
    return this.run(() => {
      this.poolError = null;
      for (const e of this.emulators.values()) {
        if (e.status === 'error') this.setStatus(e, 'stopped');
        e.error = null;
      }
      this.schedule();
      this.changed();
    });
  }

  // ---- Internals ----

  private run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private changed() {
    const json = JSON.stringify(this.snapshot());
    if (json === this.lastSnapshot) return;
    this.lastSnapshot = json;
    this.emit('change', json);
  }

  private emulator(avd: string) {
    const e = this.emulators.get(avd);
    if (!e) throw new HttpError(404, `No AVD named ${avd}`);
    return e;
  }

  private newEmulator(avd: string, status: EmulatorStatus = 'stopped'): Emulator {
    return {
      avd,
      serial: null,
      status,
      statusSince: Date.now(),
      inPool: !this.config.excludedAvds.includes(avd),
      managed: avd.startsWith(android.MANAGED_PREFIX),
      startedByRouter: false,
      leaseId: null,
      activity: null,
      error: null,
    };
  }

  private setStatus(e: Emulator, status: EmulatorStatus) {
    if (e.status === status) return;
    e.status = status;
    e.statusSince = Date.now();
  }

  private runningCount() {
    let count = 0;
    for (const e of this.emulators.values()) if (e.inPool && RUNNING.includes(e.status)) count++;
    return count;
  }

  private async sync() {
    this.expireLeases();
    await this.reconcile();
    this.schedule();
    this.trimIdle();
    this.changed();
  }

  /** Brings tracked state in line with the AVDs on disk and the emulators adb can see. */
  private async reconcile() {
    const avds = android.listAvds();
    const { byAvd } = await android.runningEmulators();

    for (const avd of avds) if (!this.emulators.has(avd)) this.emulators.set(avd, this.newEmulator(avd));

    for (const [avd, e] of this.emulators) {
      if (!avds.includes(avd)) {
        if (e.status !== 'creating') this.emulators.delete(avd);
        continue;
      }
      const serial = byAvd.get(avd);
      const deadline = this.bootDeadlines.get(avd) ?? 0;

      if (serial) {
        e.serial = serial;
        if (e.status === 'stopped' || e.status === 'error') {
          // Started outside the router (e.g. from Android Studio).
          this.setStatus(e, 'booting');
          this.bootDeadlines.set(avd, Date.now() + BOOT_TIMEOUT_MS);
        }
        if (e.status === 'booting') {
          if (await android.isBooted(serial)) this.onBooted(e);
          else if (Date.now() > deadline) this.fail(e, 'Emulator did not finish booting in time');
        }
      } else if (e.status === 'booting') {
        if (Date.now() > deadline) this.fail(e, `Emulator never appeared in adb; see ${android.logPath(avd)}`);
      } else if (e.status === 'idle' || e.status === 'leased' || e.status === 'stopping') {
        this.onGone(e);
      }
    }
  }

  /** Hands waiting leases, oldest first, to idle emulators, booting or creating more while under the cap. */
  private schedule() {
    const waiting = [...this.leases.values()].filter((l) => l.status === 'waiting').sort((a, b) => a.createdAt - b.createdAt);

    for (const lease of waiting) {
      const pool = [...this.emulators.values()].filter((e) => e.inPool);

      const idle = pool.find((e) => e.status === 'idle');
      if (idle) {
        this.assign(idle, lease);
        this.setStatus(idle, 'leased');
        lease.status = 'ready';
        this.launch(lease);
        continue;
      }

      if (this.runningCount() >= this.config.maxRunning) break;

      const stopped = pool.find((e) => e.status === 'stopped');
      if (stopped) {
        this.assign(stopped, lease);
        lease.status = 'booting';
        this.boot(stopped);
        continue;
      }

      // Don't keep minting AVDs while something is broken; the UI surfaces the error to clear.
      if (this.poolError || pool.some((e) => e.status === 'error')) break;
      const created = this.createEmulator(lease);
      if (!created) break;
    }
  }

  /** Shuts down router-started idle emulators that exceed the cap or have sat unused too long. */
  private trimIdle() {
    const idle = [...this.emulators.values()]
      .filter((e) => e.inPool && e.startedByRouter && e.status === 'idle')
      .sort((a, b) => a.statusSince - b.statusSince);
    let excess = this.runningCount() - this.config.maxRunning;
    const idleLimitMs = this.config.idleShutdownMinutes * 60_000;

    for (const e of idle) {
      const expired = idleLimitMs > 0 && Date.now() - e.statusSince > idleLimitMs;
      if (excess > 0 || expired) {
        this.stop(e);
        excess--;
      }
    }
  }

  private expireLeases() {
    const now = Date.now();
    for (const lease of this.leases.values()) {
      const dead = now - lease.heartbeatAt > LEASE_TTL_MS || (lease.pid !== null && !isAlive(lease.pid));
      if (dead) this.releaseLease(lease.id);
    }
  }

  private assign(e: Emulator, lease: Lease) {
    e.leaseId = lease.id;
    lease.avd = e.avd;
    lease.opened = false;
    lease.error = null;
  }

  private releaseLease(id: string) {
    const lease = this.leases.get(id);
    if (!lease) return;
    this.leases.delete(id);
    this.launching.delete(id);
    const e = lease.avd ? this.emulators.get(lease.avd) : undefined;
    if (!e || e.leaseId !== id) return;
    e.leaseId = null;
    // Keep it running and warm for the next server; a booting one becomes idle when it finishes.
    if (e.status === 'leased') this.setStatus(e, 'idle');
    if (e.serial) android.removeReverse(e.serial, lease.metroPort).catch(() => {});
  }

  /** Puts a lease whose emulator went away back in line for another one. */
  private requeue(e: Emulator, reason: string) {
    const lease = e.leaseId ? this.leases.get(e.leaseId) : undefined;
    e.leaseId = null;
    if (!lease) return;
    lease.avd = null;
    lease.status = 'waiting';
    lease.opened = false;
    lease.error = reason;
  }

  private onBooted(e: Emulator) {
    this.bootDeadlines.delete(e.avd);
    const lease = e.leaseId ? this.leases.get(e.leaseId) : undefined;
    if (!lease) {
      e.leaseId = null;
      this.setStatus(e, 'idle');
      return;
    }
    this.setStatus(e, 'leased');
    lease.status = 'ready';
    this.launch(lease);
  }

  private onGone(e: Emulator) {
    this.requeue(e, `${e.avd} shut down; waiting for another emulator`);
    e.serial = null;
    e.activity = null;
    e.startedByRouter = false;
    this.setStatus(e, 'stopped');
  }

  private fail(e: Emulator, message: string) {
    this.bootDeadlines.delete(e.avd);
    if (e.serial) android.killEmulator(e.serial).catch(() => {});
    this.requeue(e, `${e.avd} failed: ${message}`);
    e.serial = null;
    e.activity = null;
    e.error = message;
    this.setStatus(e, 'error');
  }

  private boot(e: Emulator) {
    const used = [...this.emulators.values()].map((other) => other.serial).filter((s): s is string => Boolean(s));
    const port = android.freeEmulatorPort(used);
    if (port === null) {
      this.fail(e, 'No free emulator ports (5554–5584)');
      return;
    }
    e.serial = `emulator-${port}`;
    e.error = null;
    e.startedByRouter = true;
    this.setStatus(e, 'booting');
    this.bootDeadlines.set(e.avd, Date.now() + BOOT_TIMEOUT_MS);

    const child = android.bootEmulator(e.avd, port, this.config);
    const onExit = (detail: string) =>
      this.run(() => {
        if (e.status !== 'booting') return;
        this.fail(e, `Emulator ${detail}; see ${android.logPath(e.avd)}`);
        this.schedule();
        this.changed();
      });
    child.on('error', (err) => onExit(`could not start (${err.message})`));
    child.on('exit', (code) => onExit(`exited with code ${code}`));
  }

  private stop(e: Emulator) {
    if (!e.serial) return;
    this.requeue(e, `${e.avd} was stopped; waiting for another emulator`);
    this.setStatus(e, 'stopping');
    android.killEmulator(e.serial).catch((err) => console.error(`[pool] could not stop ${e.avd}:`, err.message));
  }

  private templateAvd(): string | null {
    const avds = android.listAvds();
    if (this.config.templateAvd && avds.includes(this.config.templateAvd)) return this.config.templateAvd;
    return avds.find((avd) => !avd.startsWith(android.MANAGED_PREFIX)) ?? avds[0] ?? null;
  }

  /** Creates a new AVD in the background. With a lease, the new emulator boots for it as soon as it exists. */
  private createEmulator(lease?: Lease): Emulator | null {
    const template = this.templateAvd();
    if (!template) {
      this.poolError = 'No AVD to copy. Create one in Android Studio first.';
      return null;
    }
    const e = this.newEmulator(android.nextManagedName(this.emulators.keys()), 'creating');
    this.emulators.set(e.avd, e);
    if (lease) {
      this.assign(e, lease);
      lease.status = 'booting';
    }
    e.activity = `Creating from ${template}`;

    android.createAvd(e.avd, template).then(
      () =>
        this.run(() => {
          e.activity = null;
          this.setStatus(e, 'stopped');
          if (e.leaseId && this.leases.has(e.leaseId)) this.boot(e);
          else e.leaseId = null;
          this.schedule();
          this.changed();
        }),
      (err: Error) =>
        this.run(() => {
          this.poolError = `Could not create ${e.avd}: ${err.message}`;
          this.requeue(e, this.poolError);
          this.emulators.delete(e.avd);
          android.deleteAvd(e.avd);
          this.changed();
        }),
    );
    return e;
  }

  /** Points the lease's emulator at its Metro server and opens the app, installing Expo Go if needed. */
  private launch(lease: Lease) {
    const e = lease.avd ? this.emulators.get(lease.avd) : undefined;
    if (!lease.app || lease.status !== 'ready' || !e?.serial || this.launching.has(lease.id)) return;
    this.launching.add(lease.id);
    const { serial } = e;
    const { url, expoGoSdk, apk } = lease.app;

    (async () => {
      await android.reverse(serial, lease.metroPort);
      if (expoGoSdk && !(await android.hasPackage(serial, EXPO_GO_PACKAGE))) {
        e.activity = 'Installing Expo Go';
        this.changed();
        await android.installApk(serial, await ensureExpoGoApk(expoGoSdk));
      }
      if (apk && !(await android.hasPackage(serial, apk.packageId))) {
        e.activity = 'Installing dev build';
        this.changed();
        await android.installApk(serial, apk.path);
      }
      await android.openUrl(serial, url);
      lease.opened = true;
      lease.error = null;
    })()
      .catch((err: Error) => {
        lease.error = `Could not open the app: ${err.message}`;
      })
      .finally(() => {
        e.activity = null;
        this.launching.delete(lease.id);
        this.changed();
      });
  }

  private async allocateMetroPort(): Promise<number> {
    const taken = new Set([...this.leases.values()].map((l) => l.metroPort));
    const base = this.config.metroBasePort;
    for (let port = base; port < base + 100; port++) {
      if (!taken.has(port) && (await isPortFree(port))) return port;
    }
    throw new HttpError(503, 'No free Metro port');
  }
}
