import type { RenderLyricLine } from './lyrics-render-model';

export interface NativeLyricsBounds {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface NativeLyricsOptions {
  align: string;
  followAnchor: number;
  enableSpring: boolean;
  enableScale: boolean;
  enableBlur: boolean;
  hidePassedLines: boolean;
  wordFadeWidth: number;
  /** CSS pixels from the scene widget; the native host converts this to sp. */
  lineFontSizePx?: number;
  /** CSS font weight from the active scene preset. */
  fontWeight?: number;
  /** Resolved scene foreground color (normally an rgb()/rgba() string). */
  foregroundColor?: string;
  /** Difference between the lyric timeline and the audio clock, in milliseconds. */
  timingOffsetMs?: number;
}

interface NativeListenerHandle {
  remove: () => Promise<void> | void;
}

interface CapacitorYaqmcNativePlugin {
  invoke(options: { method: string; params?: unknown }): Promise<{ value: unknown }>;
  addListener(
    event: string,
    listener: (payload: Record<string, unknown>) => void,
  ): Promise<NativeListenerHandle> | NativeListenerHandle;
}

interface GlobalWithCapacitor {
  Capacitor?: {
    Plugins?: {
      YaqmcNative?: CapacitorYaqmcNativePlugin;
    };
  };
}

function getCapacitorPlugin(): CapacitorYaqmcNativePlugin | undefined {
  if (typeof globalThis === 'undefined') return undefined;
  const root = globalThis as unknown as GlobalWithCapacitor;
  return root.Capacitor?.Plugins?.YaqmcNative;
}

export async function showNativeLyrics(
  bounds: NativeLyricsBounds | null,
  lines: RenderLyricLine[],
  options: NativeLyricsOptions,
): Promise<void> {
  const plugin = getCapacitorPlugin();
  if (!plugin) return;
  await plugin.invoke({
    method: 'lyrics_show',
    params: { bounds, lines, options },
  });
}

export async function updateNativeLyrics(
  bounds: NativeLyricsBounds | null,
  lines: RenderLyricLine[] | null,
  options: NativeLyricsOptions,
): Promise<void> {
  const plugin = getCapacitorPlugin();
  if (!plugin) return;
  await plugin.invoke({
    method: 'lyrics_update',
    params: { bounds, ...(lines ? { lines } : {}), options },
  });
}

export async function hideNativeLyrics(): Promise<void> {
  const plugin = getCapacitorPlugin();
  if (!plugin) return;
  await plugin.invoke({
    method: 'lyrics_hide',
  });
}

export function onNativeLyricsSeek(callback: (positionMs: number) => void): () => void {
  const plugin = getCapacitorPlugin();
  if (!plugin) return () => {};
  let removed = false;
  let handle: { remove: () => Promise<void> | void } | null = null;

  try {
    const result = plugin.addListener('lyricsSeek', (event) => {
      const pos = event.positionMs;
      if (typeof pos === 'number') {
        callback(pos);
      }
    });

    if (result && 'then' in result && typeof result.then === 'function') {
      void result
        .then((h) => {
          if (removed) {
            void h?.remove();
          } else {
            handle = h;
          }
        })
        .catch((error: unknown) => {
          console.warn('Failed to attach lyricsSeek listener', error);
        });
    } else if (result && 'remove' in result && typeof result.remove === 'function') {
      if (removed) {
        void result.remove();
      } else {
        handle = result;
      }
    }
  } catch (error) {
    console.warn('Failed to attach lyricsSeek listener', error);
  }

  return () => {
    removed = true;
    try {
      void handle?.remove();
    } catch {
      // ignore cleanup errors
    }
  };
}
