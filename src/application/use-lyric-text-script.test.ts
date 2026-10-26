import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultPreferences, usePreferencesStore } from './preferences';
import { useLyricTextScript } from './use-lyric-text-script';

const converter = vi.hoisted(() => ({ load: vi.fn(), ready: vi.fn(() => false) }));
vi.mock('./lyrics-text', () => ({
  loadTraditionalLyrics: converter.load,
  traditionalLyricsReady: converter.ready,
}));

beforeEach(() => {
  converter.load.mockReset();
  converter.ready.mockReturnValue(false);
  usePreferencesStore.setState({ lyrics: { ...defaultPreferences.lyrics } });
});

describe('deferred Traditional Chinese lyrics', () => {
  it('does not load conversion dictionaries for original text', () => {
    const { result } = renderHook(useLyricTextScript);
    expect(result.current).toBe('original');
    expect(converter.load).not.toHaveBeenCalled();
  });

  it('shows original text until the selected conversion dictionary finishes loading', async () => {
    let finish!: () => void;
    converter.load.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const { result } = renderHook(useLyricTextScript);
    act(() =>
      usePreferencesStore.setState({
        lyrics: { ...defaultPreferences.lyrics, chineseScript: 'traditional' },
      }),
    );
    expect(converter.load).toHaveBeenCalledTimes(1);
    expect(result.current).toBe('original');
    await act(async () => finish());
    await waitFor(() => expect(result.current).toBe('traditional'));
    act(() => usePreferencesStore.setState({ lyrics: { ...defaultPreferences.lyrics } }));
    expect(result.current).toBe('original');
  });

  it('does not apply a conversion that finishes after the user restores original text', async () => {
    let finish!: () => void;
    converter.load.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    usePreferencesStore.setState({
      lyrics: { ...defaultPreferences.lyrics, chineseScript: 'traditional' },
    });
    const { result } = renderHook(useLyricTextScript);
    act(() => usePreferencesStore.setState({ lyrics: { ...defaultPreferences.lyrics } }));
    await act(async () => finish());
    expect(result.current).toBe('original');
  });
});
