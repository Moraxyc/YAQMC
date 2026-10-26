import { useTranslation } from 'react-i18next';
import type { Song } from '../domain/music';

export function TrackAccessBadge({ song }: { song: Song }) {
  const { t } = useTranslation('player');
  const access = song.availability;
  const label =
    access.status === 'entitlement-required'
      ? t(access.requiredTier === 'purchase' ? 'trackPurchase' : 'trackMembership')
      : access.status === 'unavailable' && access.reason === 'copyright-restricted'
        ? t('trackCopyright')
        : null;
  return label ? <span className="track-access-badge">{label}</span> : null;
}
