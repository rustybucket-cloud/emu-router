import fs from 'node:fs';
import http from 'node:http';
import type { Config } from './config.ts';
import { HttpError, type Pool } from './pool.ts';

const UI_PATH = new URL('../ui/index.html', import.meta.url);

type Handler = (params: string[], body: any) => unknown | Promise<unknown>;

const CONFIG_KEYS: (keyof Config)[] = ['maxRunning', 'templateAvd', 'headless', 'idleShutdownMinutes', 'emulatorArgs', 'metroBasePort'];

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new HttpError(400, 'Body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value ?? { ok: true }));
}

export function startServer(pool: Pool, port: number) {
  const streams = new Set<http.ServerResponse>();
  pool.on('change', (json: string) => {
    for (const res of streams) res.write(`data: ${json}\n\n`);
  });

  const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/api\/state$/, () => pool.snapshot()],
    [
      'PUT',
      /^\/api\/config$/,
      (_, body) => pool.updateConfig(Object.fromEntries(CONFIG_KEYS.filter((k) => k in body).map((k) => [k, body[k]]))),
    ],
    ['POST', /^\/api\/errors\/clear$/, () => pool.clearErrors()],

    ['POST', /^\/api\/avds$/, () => pool.addEmulator()],
    ['POST', /^\/api\/avds\/([^/]+)\/start$/, ([avd]) => pool.startEmulator(avd)],
    ['POST', /^\/api\/avds\/([^/]+)\/stop$/, ([avd]) => pool.stopEmulator(avd)],
    ['PUT', /^\/api\/avds\/([^/]+)\/pool$/, ([avd], body) => pool.setInPool(avd, Boolean(body.inPool))],
    ['DELETE', /^\/api\/avds\/([^/]+)$/, ([avd]) => pool.deleteEmulator(avd)],

    [
      'POST',
      /^\/api\/leases$/,
      (_, body) =>
        pool.requestLease({
          project: String(body.project ?? 'unknown'),
          cwd: String(body.cwd ?? ''),
          pid: Number.isInteger(body.pid) ? body.pid : null,
        }),
    ],
    ['GET', /^\/api\/leases\/([^/]+)$/, ([id]) => pool.getLease(id)],
    ['POST', /^\/api\/leases\/([^/]+)\/heartbeat$/, ([id]) => pool.heartbeat(id)],
    [
      'POST',
      /^\/api\/leases\/([^/]+)\/app$/,
      ([id], body) => {
        if (typeof body.url !== 'string') throw new HttpError(400, 'url is required');
        const apk = typeof body.apk?.path === 'string' && typeof body.apk?.packageId === 'string' ? { path: body.apk.path, packageId: body.apk.packageId } : null;
        return pool.setApp(id, { url: body.url, expoGoSdk: typeof body.expoGoSdk === 'string' ? body.expoGoSdk : null, apk });
      },
    ],
    ['POST', /^\/api\/leases\/([^/]+)\/open$/, ([id]) => pool.reopen(id)],
    ['DELETE', /^\/api\/leases\/([^/]+)$/, ([id]) => pool.release(id)],

    [
      'POST',
      /^\/api\/shutdown$/,
      () => {
        setTimeout(() => process.exit(0), 50);
      },
    ],
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    try {
      // Block other web pages from driving the daemon; the CLI sends no Origin, the dashboard sends its own.
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
        throw new HttpError(403, 'Cross-origin requests are not allowed');
      }

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(UI_PATH));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(pool.snapshot())}\n\n`);
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }

      for (const [method, pattern, handler] of routes) {
        const match = req.method === method && pattern.exec(url.pathname);
        if (!match) continue;
        const params = match.slice(1).map(decodeURIComponent);
        const body = req.method === 'GET' ? {} : await readBody(req);
        sendJson(res, 200, await handler(params, body));
        return;
      }

      throw new HttpError(404, 'Not found');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: (err as Error).message });
    }
  });

  return new Promise<http.Server>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
