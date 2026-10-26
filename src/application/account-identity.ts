import { useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccountStore } from './account-runtime';
import { useSafeArtworkSource } from './artwork-source';
import { ProviderContext } from './provider-context';
import type { MusicProvider } from '../providers/music-provider';
import { DEFAULT_PROFILE_ID } from '../domain/music';

export interface AccountIdentity {
  avatarUrl: string | null;
  initial: string;
  label: string;
  summary: string;
  providerName: string;
}

export function useAccountIdentity(): AccountIdentity {
  const { t } = useTranslation('navigation');
  const provider = useContext(ProviderContext);
  const accountSnapshot = useAccountStore((state) => state.snapshot);
  const authenticated = accountSnapshot.state === 'authenticated';
  const profile = authenticated ? accountSnapshot.profile : null;
  const entitlement = authenticated ? accountSnapshot.entitlement : null;
  const providerName = provider?.displayName ?? 'YAQMC';
  const providerLabel = provider?.id === 'qqmusic' ? t('qqGuest') : providerName;
  const label = profile?.nickname.trim() || t('listener');
  const avatarUrl = useAccountAvatarUrl(profile?.avatarUrl, provider);

  return {
    avatarUrl,
    initial: Array.from(label.trim())[0] ?? 'L',
    label,
    summary:
      entitlement?.tier === 'unknown' && entitlement.membership === 'unknown'
        ? t('accountEntitlementUnconfirmed')
        : entitlement
          ? t('accountSummary', {
              tier: t(`accountTier.${entitlement.tier}`),
              membership: t(`accountMembership.${entitlement.membership}`),
            })
          : providerLabel,
    providerName,
  };
}

export function useAccountAvatarUrl(
  value: string | null | undefined,
  provider: Pick<MusicProvider, 'id' | 'profileId'> | null,
): string | null {
  return useSafeArtworkSource(safeAccountAvatarUrl(value), {
    pendingRemote: 'hide',
    provider: provider
      ? { providerId: provider.id, profileId: provider.profileId ?? DEFAULT_PROFILE_ID }
      : null,
  });
}

export function safeAccountAvatarUrl(value: string | null | undefined): string | null {
  if (!value || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      ([
        'qpic.y.qq.com',
        'q.qlogo.cn',
        'thirdwx.qlogo.cn',
        'thirdqq.qlogo.cn',
        'imge.kugou.com',
        'singerimg.kugou.com',
        'c1.kgimg.com',
        'i.scdn.co',
      ].includes(url.hostname) ||
        url.hostname.endsWith('.music.126.net')) &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
