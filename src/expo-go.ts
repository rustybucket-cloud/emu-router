import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { APK_CACHE_DIR } from './config.ts';

export const EXPO_GO_PACKAGE = 'host.exp.exponent';

/** Downloads (once) the Expo Go APK matching an SDK version like "54.0.0" and returns its path. */
export async function ensureExpoGoApk(sdkVersion: string): Promise<string> {
  const res = await fetch('https://api.expo.dev/v2/versions/latest');
  if (!res.ok) throw new Error(`Expo versions API returned ${res.status}`);
  const { data } = (await res.json()) as { data: { sdkVersions: Record<string, { androidClientUrl?: string }> } };

  const url = data.sdkVersions[sdkVersion]?.androidClientUrl;
  if (!url) throw new Error(`No Expo Go build for SDK ${sdkVersion}`);

  const file = path.join(APK_CACHE_DIR, path.basename(new URL(url).pathname));
  if (fs.existsSync(file)) return file;

  fs.mkdirSync(APK_CACHE_DIR, { recursive: true });
  const download = await fetch(url);
  if (!download.ok || !download.body) throw new Error(`Expo Go download failed (${download.status})`);
  const partial = `${file}.part`;
  await pipeline(Readable.fromWeb(download.body as WebReadableStream), fs.createWriteStream(partial));
  fs.renameSync(partial, file);
  return file;
}
