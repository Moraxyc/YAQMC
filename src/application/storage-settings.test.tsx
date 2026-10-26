import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ native: true }));
const invoke = vi.hoisted(() => vi.fn());
const clearMemory = vi.hoisted(() => vi.fn());
vi.mock('./native-player-runtime', () => ({
  get isNativeRuntime() {
    return runtime.native;
  },
}));
vi.mock('./yaqmc-runtime', () => ({ getYaqmcClient: () => ({ invoke }) }));
vi.mock('./artwork-cache', () => ({ clearArtworkMemoryCache: clearMemory }));

import { useStorageSettings } from './storage-settings';

const stats = {
  totalBytes: 123,
  mediaBytes: 100,
  artworkBytes: 20,
  componentBytes: 3,
  mediaEntries: 1,
  artworkEntries: 2,
  componentEntries: 1,
  metadataEntries: 2,
  lyricEntries: 1,
  mediaLimitBytes: 1024,
  artworkLimitBytes: 1024,
};
const cleared = {
  ...stats,
  totalBytes: 0,
  componentBytes: 0,
  componentEntries: 0,
  mediaBytes: 0,
  artworkBytes: 0,
  mediaEntries: 0,
  artworkEntries: 0,
  metadataEntries: 0,
  lyricEntries: 0,
};

describe('app storage settings', () => {
  beforeEach(() => {
    runtime.native = true;
    invoke.mockReset().mockResolvedValue(stats);
    clearMemory.mockReset();
  });
  it('uses host-owned app cache methods without a provider/profile dependency', async () => {
    const { result, rerender } = renderHook(() => useStorageSettings());
    await waitFor(() => expect(result.current.cache?.totalBytes).toBe(123));
    rerender();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('app_cache_stats');
    invoke.mockResolvedValueOnce(cleared);
    await act(() => result.current.clearCache());
    expect(invoke).toHaveBeenLastCalledWith('app_clear_cache');
    expect(result.current.cache?.totalBytes).toBe(0);
    expect(clearMemory).toHaveBeenCalledTimes(1);
  });
  it('reports loading separately from a read failure and supports retry', async () => {
    invoke.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useStorageSettings());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.error).toBe('read'));
    expect(result.current.available).toBe(true);
    expect(result.current.loading).toBe(false);
    await act(() => result.current.refresh());
    expect(result.current.error).toBeNull();
    expect(result.current.cache).toEqual(stats);
  });
  it('reports partial clear failure, invalidates stale totals and allows recovery', async () => {
    const { result } = renderHook(() => useStorageSettings());
    await waitFor(() => expect(result.current.cache).not.toBeNull());
    invoke.mockRejectedValueOnce(new Error('locked file'));
    await act(() => result.current.clearCache());
    expect(result.current.error).toBe('clear');
    expect(result.current.cache).toBeNull();
    expect(result.current.clearing).toBe(false);
    expect(clearMemory).toHaveBeenCalledTimes(1);
    await act(() => result.current.refresh());
    expect(result.current.error).toBeNull();
  });
  it('ignores stale reads and suppresses duplicate clear operations', async () => {
    let finishRead!: (value: unknown) => void;
    let finishClear!: (value: unknown) => void;
    invoke.mockImplementation(
      (method: string) =>
        new Promise((resolve) => {
          if (method === 'app_cache_stats') finishRead = resolve;
          else finishClear = resolve;
        }),
    );
    const { result } = renderHook(() => useStorageSettings());
    let mutation!: Promise<void>;
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('app_cache_stats'));
    act(() => {
      mutation = result.current.clearCache();
    });
    await act(async () => {
      await result.current.clearCache();
      await result.current.refresh();
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    await act(async () => {
      finishClear(cleared);
      await mutation;
    });
    await act(async () => finishRead(stats));
    expect(result.current.cache?.totalBytes).toBe(0);
  });
  it('keeps non-native previews unavailable without issuing native calls', async () => {
    runtime.native = false;
    const { result } = renderHook(() => useStorageSettings());
    await act(async () => {
      await result.current.clearCache();
      await result.current.refresh();
    });
    expect(result.current.available).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
