import { useTranslation } from 'react-i18next';
import type { AccountIdentity } from '../application/account-identity';
import { useState } from 'react';

export function AccountAvatar({
  identity,
  className,
}: {
  identity: Pick<AccountIdentity, 'avatarUrl' | 'label' | 'initial'>;
  className: string;
}) {
  const { t } = useTranslation('navigation');
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return identity.avatarUrl && identity.avatarUrl !== failedSource ? (
    <img
      className={className}
      src={identity.avatarUrl}
      alt={t('accountAvatar', { nickname: identity.label })}
      referrerPolicy="no-referrer"
      onError={() => setFailedSource(identity.avatarUrl)}
      onLoad={() => setFailedSource(null)}
    />
  ) : (
    <span className={className} aria-hidden="true">
      {identity.initial}
    </span>
  );
}
