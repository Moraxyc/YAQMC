import { isNativeRuntime } from './native-player-runtime';
import { getYaqmcClient } from './yaqmc-runtime';
import type { ActiveProviderSelection } from './provider-context';

const memoryCache = new Map<string, string>();
const pendingCache = new Map<string, Promise<string>>();
const MAX_MEMORY_BYTES = 16 * 1024 * 1024;
const MAX_MEMORY_ENTRIES = 128;
const MAX_PENDING = 128;
const MAX_CONCURRENT = 4;
const queued: Array<() => void> = [];
let active = 0;
let memoryBytes = 0;
let cacheGeneration = 0;

function cacheImage(key: string, value: string) {
  const previous = memoryCache.get(key);
  if (previous) memoryBytes -= previous.length * 2;
  memoryCache.delete(key);
  if (value.length * 2 > MAX_MEMORY_BYTES) return;
  memoryCache.set(key, value);
  memoryBytes += value.length * 2;
  while (memoryCache.size > MAX_MEMORY_ENTRIES || memoryBytes > MAX_MEMORY_BYTES) {
    const oldest = memoryCache.keys().next().value!;
    memoryBytes -= memoryCache.get(oldest)!.length * 2;
    memoryCache.delete(oldest);
  }
}

function schedule<T>(operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      active++;
      let task: Promise<T>;
      try {
        task = operation();
      } catch (error) {
        task = Promise.reject(error);
      }
      void task.then(resolve, reject).finally(() => {
        active--;
        queued.shift()?.();
      });
    };
    if (active < MAX_CONCURRENT) start();
    else queued.push(start);
  });
}

const CACHEABLE_ARTWORK_HOSTS = new Set([
  'y.gtimg.cn',
  'qpic.y.qq.com',
  'music-file.y.qq.com',
  'q.qlogo.cn',
  'thirdwx.qlogo.cn',
  'thirdqq.qlogo.cn',
]);

const Y_QQ_ARTWORK_PATH_PREFIXES = ['/m/resource/calendar/', '/music/common/upload/'] as const;

export function isCacheableArtworkSource(url: string, provider?: ActiveProviderSelection): boolean {
  try {
    const parsed = new URL(url);
    const allowedHost =
      CACHEABLE_ARTWORK_HOSTS.has(parsed.hostname) ||
      (parsed.hostname === 'y.qq.com' &&
        Y_QQ_ARTWORK_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix)));
    return (
      parsed.protocol === 'https:' &&
      (allowedHost || Boolean(provider && provider.providerId !== 'qqmusic')) &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.hash === '' &&
      (parsed.port === '' || parsed.port === '443')
    );
  } catch {
    return false;
  }
}

export function isCachedArtworkDataUri(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^data:(image\/[a-z0-9][a-z0-9!#$&^_.+-]*);base64,([a-z0-9+/]+={0,2})$/i.exec(
    value,
  );
  const payload = match?.[2];
  if (!payload || payload.length % 4 !== 0) return false;
  try {
    return globalThis.btoa(globalThis.atob(payload)) === payload;
  } catch {
    return false;
  }
}

export function cachedArtworkSource(
  url: string,
  provider?: ActiveProviderSelection,
): Promise<string> | null {
  if (!isNativeRuntime || !isCacheableArtworkSource(url, provider)) return null;
  const scoped = provider && provider.providerId !== 'qqmusic' ? provider : undefined;
  const key = scoped ? JSON.stringify([scoped.providerId, scoped.profileId, url]) : url;
  const existing = memoryCache.get(key);
  if (existing) {
    memoryCache.delete(key);
    memoryCache.set(key, existing);
    return Promise.resolve(existing);
  }
  const pending = pendingCache.get(key);
  if (pending) return pending;
  if (pendingCache.size >= MAX_PENDING) return Promise.reject(new Error('Artwork queue is full'));
  const requestGeneration = cacheGeneration;
  const client = getYaqmcClient();
  const operation = schedule(() =>
    scoped
      ? client.invoke('provider_cache_artwork', { ...scoped, url })
      : client.invoke('qqmusic_cache_artwork', { url }),
  );
  const request = operation
    .then((value) => {
      if (!isCachedArtworkDataUri(value)) {
        throw new Error('The native artwork cache returned an invalid image payload');
      }
      if (cacheGeneration === requestGeneration) cacheImage(key, value);
      return value;
    })
    .finally(() => {
      if (pendingCache.get(key) === request) pendingCache.delete(key);
    });
  pendingCache.set(key, request);
  return request;
}

export function clearArtworkMemoryCache(): void {
  cacheGeneration += 1;
  memoryCache.clear();
  memoryBytes = 0;
  pendingCache.clear();
}
