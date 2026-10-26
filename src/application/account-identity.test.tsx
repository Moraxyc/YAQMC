import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAccountRuntimeForTest, useAccountStore } from './account-runtime';
import { clearArtworkMemoryCache } from './artwork-cache';
import { ProviderContext } from './provider-context';
import type { MusicProvider } from '../providers/music-provider';
import { safeAccountAvatarUrl, useAccountAvatarUrl, useAccountIdentity } from './account-identity';
import i18n from '../i18n';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('./native-player-runtime', () => ({ isNativeRuntime: true }));
vi.mock('./yaqmc-runtime', () => ({
  getYaqmcClient: () => ({ invoke, on: () => () => undefined }),
  getHostBridge: () => ({ kind: 'electron' }),
}));

const image = 'data:image/png;base64,AA==';
const netease = {
  id: 'org.yaqmc.providers.music.netease',
  profileId: 'work',
  displayName: 'NetEase Cloud Music',
} as MusicProvider;

describe('account avatars', () => {
  beforeEach(() => {
    resetAccountRuntimeForTest();
    clearArtworkMemoryCache();
    invoke.mockReset();
  });

  it.each([
    'https://p1.music.126.net/avatar.jpg',
    'https://p2.music.126.net/avatar.jpg?param=100y100',
    'https://thirdwx.qlogo.cn/avatar.jpg',
    'https://imge.kugou.com/avatar.jpg',
    'https://singerimg.kugou.com/avatar.jpg',
    'https://c1.kgimg.com/avatar.jpg',
    'https://i.scdn.co/image/avatar',
  ])('accepts official HTTPS avatar source %s', (url) => {
    expect(safeAccountAvatarUrl(url)).toBe(url);
  });

  it.each([
    'https://p1.music.126.net.evil.example/avatar.jpg',
    'https://evil.music.126.net.example/avatar.jpg',
    'https://example.com/avatar.jpg',
    'https://c1.kgimg.com.evil.example/avatar.jpg',
    'http://p1.music.126.net/avatar.jpg',
    'https://user:pass@p1.music.126.net/avatar.jpg',
    'https://p1.music.126.net:444/avatar.jpg',
    'https://p1.music.126.net/avatar.jpg#fragment',
    'data:image/png;base64,AA==',
  ])('rejects unsafe or unrelated avatar source %s', (url) => {
    expect(safeAccountAvatarUrl(url)).toBeNull();
  });

  it('loads the signed-in NetEase avatar through its own provider and profile', async () => {
    invoke.mockResolvedValue(image);
    const avatarUrl = 'https://p2.music.126.net/account-avatar.jpg';
    useAccountStore.setState({
      snapshot: {
        state: 'authenticated',
        providerId: netease.id,
        profileId: 'work',
        revision: 1,
        profile: { avatarUrl, nickname: 'Listener', maskedIdentity: '***1234' },
        entitlement: {
          tier: 'music-vip',
          membership: 'active',
          expiresAtMs: null,
          permittedQualities: [],
          observedMaximumQuality: null,
          restrictions: [],
        },
        capabilities: {
          qrLogin: true,
          favoriteRead: true,
          favoriteWrite: false,
          playlistRead: true,
          playlistWrite: false,
          recentHistoryRead: false,
        },
      },
    });
    const { result } = renderHook(() => useAccountIdentity(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(ProviderContext, { value: netease }, children),
    });
    await waitFor(() => expect(result.current.avatarUrl).toBe(image));
    expect(result.current.label).toBe('Listener');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('provider_cache_artwork', {
      providerId: netease.id,
      profileId: 'work',
      url: avatarUrl,
    });
    useAccountStore.setState((state) => ({
      snapshot: {
        ...state.snapshot,
        entitlement: {
          tier: 'unknown',
          membership: 'unknown',
          expiresAtMs: null,
          permittedQualities: [],
          observedMaximumQuality: null,
          restrictions: [],
        },
      } as typeof state.snapshot,
    }));
    await waitFor(() =>
      expect(result.current.summary).toBe(i18n.t('navigation:accountEntitlementUnconfirmed')),
    );
  });

  it('keeps the avatar hidden when the owning provider rejects the image', async () => {
    invoke.mockRejectedValue(new Error('origin not granted'));
    const { result } = renderHook(() =>
      useAccountAvatarUrl('https://p1.music.126.net/denied-avatar.jpg', netease),
    );
    await waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    expect(result.current).toBeNull();
  });

  it('drops late avatar data after switching account profiles', async () => {
    let finishOld!: (value: string) => void;
    let finishNew!: (value: string) => void;
    invoke
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishOld = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishNew = resolve;
        }),
      );
    const { result, rerender } = renderHook(
      ({ profileId }) =>
        useAccountAvatarUrl('https://p1.music.126.net/shared-avatar.jpg', {
          ...netease,
          profileId,
        }),
      { initialProps: { profileId: 'first' } },
    );
    rerender({ profileId: 'second' });
    await act(async () => finishOld(image));
    expect(result.current).toBeNull();
    await act(async () => finishNew('data:image/png;base64,AQ=='));
    await waitFor(() => expect(result.current).toBe('data:image/png;base64,AQ=='));
    expect(invoke).toHaveBeenLastCalledWith('provider_cache_artwork', {
      providerId: netease.id,
      profileId: 'second',
      url: 'https://p1.music.126.net/shared-avatar.jpg',
    });
  });
});
