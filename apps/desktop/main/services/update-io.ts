import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, lstat, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { AppUpdateCandidate, AppUpdateProgress } from '@yaqmc/client';

export type UpdateFetch = (url: string, init?: RequestInit) => Promise<Response>;
const HOSTS = new Set([
  'api.github.com',
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);

export function isUpdateUrlAllowed(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443') &&
      HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

export async function updateResponse(
  fetcher: UpdateFetch,
  url: string,
  signal: AbortSignal,
): Promise<Response> {
  let current = new URL(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!isUpdateUrlAllowed(current.href)) {
      throw new Error('update-redirect-denied');
    }
    const response = await fetcher(current.href, {
      signal,
      redirect: 'manual',
      credentials: 'omit',
      headers: {
        'User-Agent': 'YAQMC-Updater',
        Accept:
          current.hostname === 'api.github.com'
            ? 'application/vnd.github+json'
            : 'application/octet-stream',
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 5) throw new Error('update-too-many-redirects');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        response.status === 403 || response.status === 429
          ? 'update-rate-limited'
          : `update-http-${response.status}`,
      );
    }
    return response;
  }
  throw new Error('update-too-many-redirects');
}

export async function updateJson(
  fetcher: UpdateFetch,
  url: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await updateResponse(
    fetcher,
    url,
    AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  );
  if (!response.body) throw new Error('update-response-empty');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 8 * 1024 * 1024) throw new Error('update-metadata-too-large');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function verifyUpdateFile(
  file: string,
  asset: NonNullable<AppUpdateCandidate['asset']>,
  signal?: AbortSignal,
) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('update-package-invalid');
  if (metadata.size !== asset.size) throw new Error('update-size-mismatch');
  const hash = createHash('sha256');
  const stream = createReadStream(file, { signal });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  if (hash.digest('hex') !== asset.sha256) throw new Error('update-hash-mismatch');
}

export async function requireUpdateSpace(directory: string, bytes: number) {
  const fs = await statfs(directory, { bigint: true });
  if (fs.bavail * fs.bsize < BigInt(bytes) * 2n + 16n * 1024n * 1024n) {
    throw new Error('update-insufficient-disk-space');
  }
}

export async function downloadUpdateFile(options: {
  fetcher: UpdateFetch;
  candidate: AppUpdateCandidate;
  directory: string;
  signal: AbortSignal;
  progress: (value: AppUpdateProgress) => void;
}): Promise<string> {
  const { asset } = options.candidate;
  if (!asset) throw new Error('missing-verified-package');
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  await requireUpdateSpace(options.directory, asset.size);
  const partial = path.join(options.directory, `${options.candidate.id}.part`);
  const final = path.join(options.directory, options.candidate.id + path.extname(asset.name));
  await rm(partial, { force: true });
  const controller = new AbortController();
  const signal = AbortSignal.any([
    options.signal,
    controller.signal,
    AbortSignal.timeout(15 * 60_000),
  ]);
  let timer = setTimeout(() => controller.abort(new Error('update-no-data-timeout')), 30_000);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await updateResponse(options.fetcher, asset.url, signal);
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== asset.size) throw new Error('update-size-mismatch');
    if (!response.body) throw new Error('update-response-empty');
    reader = response.body.getReader();
    file = await open(partial, 'wx', 0o600);
    const hash = createHash('sha256');
    let transferred = 0;
    let lastEmission = 0;
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error('update-no-data-timeout')), 30_000);
      transferred += chunk.value.length;
      if (transferred > asset.size) throw new Error('update-size-mismatch');
      hash.update(chunk.value);
      await file.writeFile(chunk.value);
      if (Date.now() - lastEmission >= 150 || transferred === asset.size) {
        lastEmission = Date.now();
        options.progress({
          transferred,
          total: asset.size,
          percent: (transferred / asset.size) * 100,
        });
      }
    }
    if (transferred !== asset.size) throw new Error('update-size-mismatch');
    if (hash.digest('hex') !== asset.sha256) throw new Error('update-hash-mismatch');
    await file.sync();
    await file.close();
    file = undefined;
    await rm(final, { force: true });
    await rename(partial, final);
    return final;
  } finally {
    clearTimeout(timer);
    await reader?.cancel().catch(() => undefined);
    await file?.close().catch(() => undefined);
    await rm(partial, { force: true });
  }
}
