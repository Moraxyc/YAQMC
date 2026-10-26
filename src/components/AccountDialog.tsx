import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccountStore, type AccountRuntimeError } from '../application/account-runtime';
import { isAndroidPhoneRuntime } from '../application/host-capabilities';
import { useMusicProvider } from '../application/provider-context';
import type { AccountLoginMethodDescriptor, AccountSnapshot } from '../domain/music';
import { isAccountMusicProvider } from '../providers/music-provider';
import '../styles/account-dialog.css';

const FALLBACK_LOGIN_METHODS: readonly AccountLoginMethodDescriptor[] = [
  { id: 'qq', label: 'QQ', flow: 'oauth' },
  { id: 'wechat', label: 'WeChat', flow: 'oauth' },
];
const FALLBACK_SPOTIFY_LOGIN_METHODS: readonly AccountLoginMethodDescriptor[] = [
  { id: 'browser-oauth', label: 'Spotify browser login (PKCE)', flow: 'oauth' },
];

function hasQrLoginFallback(provider: { id?: string; displayName: string }): boolean {
  const identity = `${provider.id ?? ''} ${provider.displayName}`.toLowerCase();
  return identity.includes('netease') || identity.includes('kugou') || identity.includes('酷狗');
}

function fallbackLoginMethodsForProvider(provider: {
  id?: string;
  displayName: string;
}): readonly AccountLoginMethodDescriptor[] {
  if (provider.id === 'qqmusic') return FALLBACK_LOGIN_METHODS;
  const identity = `${provider.id ?? ''} ${provider.displayName}`.toLowerCase();
  return identity.includes('spotify') ? FALLBACK_SPOTIFY_LOGIN_METHODS : [];
}

function isOwnedState(snapshot: AccountSnapshot): boolean {
  return (
    snapshot.state === 'starting-login' ||
    snapshot.state === 'waiting-for-scan' ||
    snapshot.state === 'waiting-for-confirmation'
  );
}

function safeQrProjection(value: string | null): string | null {
  return value &&
    value.length <= 350_000 &&
    /^data:image\/(?:png|jpeg);base64,[a-z0-9+/]+={0,2}$/i.test(value)
    ? value
    : null;
}

function stateMessage(
  snapshot: AccountSnapshot,
  error: AccountRuntimeError | null,
  t: (key: string, options?: Record<string, unknown>) => string,
  providerName: string,
  providerId?: string,
): string {
  if (error) {
    return t(
      (
        {
          network: 'errorNetwork',
          authorization: 'errorAuthorization',
          'secure-store': 'errorSecureStore',
          protocol: 'errorProtocol',
          unknown: 'errorUnknown',
          'mobile-login-required': 'errorMobileLoginRequired',
          backend: 'errorBackend',
          configuration: 'errorConfiguration',
        } satisfies Record<AccountRuntimeError, string>
      )[error],
      { provider: providerName },
    );
  }
  switch (snapshot.state) {
    case 'guest':
      return t('guest', { provider: providerName });
    case 'restoring-session':
      return t('restoring');
    case 'starting-login':
      return t('starting');
    case 'waiting-for-scan':
      if (providerId === 'qqmusic' && snapshot.launchUrl) return t('waitingMobileScan');
      return t('waitingScan', { provider: providerName });
    case 'waiting-for-confirmation':
      return t('waitingConfirmation');
    case 'expired':
      return t('expired');
    case 'rejected':
      return t('rejected', { provider: providerName });
    case 'cancelled':
      return t('cancelled');
    case 'network-error':
      return t('networkError', { provider: providerName });
    case 'protocol-error':
      return t('protocolError', { provider: providerName });
    case 'authenticated':
      return t('authenticated', { nickname: snapshot.profile.nickname });
    case 'session-expired':
      return t('sessionExpired', { provider: providerName });
    case 'reauthentication-required':
      return t('reauth');
    case 'secure-store-unavailable':
      return t('secureStore');
  }
}

export function AccountDialog() {
  const provider = useMusicProvider();
  const { t } = useTranslation('accountDialog');
  const { t: common } = useTranslation('common');
  const dialogOpen = useAccountStore((state) => state.dialogOpen);
  const snapshot = useAccountStore((state) => state.snapshot);
  const displayedQrImageDataUri = useAccountStore((state) => state.displayedQrImageDataUri);
  const busy = useAccountStore((state) => state.busy);
  const error = useAccountStore((state) => state.error);
  const closeDialog = useAccountStore((state) => state.closeDialog);
  const startLogin = useAccountStore((state) => state.startLogin);
  const startQrLogin = useAccountStore((state) => state.startQrLogin);
  const reopenLogin = useAccountStore((state) => state.reopenLogin);
  const refreshQr = useAccountStore((state) => state.refreshQr);
  const cancelLogin = useAccountStore((state) => state.cancelLogin);
  const signOut = useAccountStore((state) => state.signOut);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const accountProvider = isAccountMusicProvider(provider) ? provider : null;
  const usesQqMusicPhoneLogin = provider.id === 'qqmusic' && isAndroidPhoneRuntime();
  const providerLabel = provider.id === 'qqmusic' ? 'QQ 音乐' : provider.displayName;
  const [loadedLoginMethods, setLoadedLoginMethods] = useState<{
    provider: NonNullable<typeof accountProvider>;
    methods: readonly AccountLoginMethodDescriptor[];
  } | null>(null);
  const fallbackLoginMethods = accountProvider
    ? fallbackLoginMethodsForProvider(accountProvider)
    : [];
  const loginMethods = accountProvider?.getLoginMethods
    ? loadedLoginMethods?.provider === accountProvider
      ? loadedLoginMethods.methods.length > 0
        ? loadedLoginMethods.methods
        : fallbackLoginMethods
      : fallbackLoginMethods
    : FALLBACK_LOGIN_METHODS;
  const visibleLoginMethods = usesQqMusicPhoneLogin
    ? loginMethods.filter((method) => method.id !== 'wechat')
    : loginMethods;

  useEffect(() => {
    if (!dialogOpen || !accountProvider?.getLoginMethods) return;
    const controller = new AbortController();
    void accountProvider
      .getLoginMethods(controller.signal)
      .then((methods) => {
        if (!controller.signal.aborted)
          setLoadedLoginMethods({ provider: accountProvider, methods });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setLoadedLoginMethods({ provider: accountProvider, methods: [] });
      });
    return () => controller.abort();
  }, [accountProvider, dialogOpen]);

  useEffect(() => {
    if (dialogOpen) closeRef.current?.focus();
  }, [dialogOpen]);

  if (!dialogOpen || !accountProvider) return null;

  const qrImage =
    snapshot.state === 'waiting-for-scan' ? safeQrProjection(displayedQrImageDataUri) : null;
  const effectiveError =
    snapshot.state === 'waiting-for-scan' && displayedQrImageDataUri && !qrImage
      ? 'protocol'
      : error;
  const waiting = isOwnedState(snapshot);
  // The active contract, not the current orientation, determines the authorization route.
  const canReopen = Boolean(
    accountProvider.id === 'qqmusic' &&
    qrImage &&
    snapshot.state === 'waiting-for-scan' &&
    snapshot.launchUrl &&
    accountProvider.reopenLogin,
  );
  const canStart =
    snapshot.state === 'guest' ||
    snapshot.state === 'cancelled' ||
    snapshot.state === 'rejected' ||
    snapshot.state === 'network-error' ||
    snapshot.state === 'protocol-error' ||
    snapshot.state === 'expired' ||
    snapshot.state === 'session-expired' ||
    snapshot.state === 'reauthentication-required';
  const terminal =
    snapshot.state === 'cancelled' ||
    snapshot.state === 'rejected' ||
    snapshot.state === 'network-error' ||
    snapshot.state === 'protocol-error' ||
    snapshot.state === 'expired';
  const canStartQrLogin =
    canStart &&
    (snapshot.capabilities.qrLogin || hasQrLoginFallback(accountProvider)) &&
    visibleLoginMethods.length === 0;
  const hasLoginAction = visibleLoginMethods.length > 0 || canStartQrLogin;

  const close = () => void closeDialog(accountProvider);
  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input') ??
        [],
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="account-dialog-backdrop">
      <div
        ref={dialogRef}
        className="account-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-dialog-title"
        data-login-state={snapshot.state}
        onKeyDown={trapFocus}
      >
        <header className="account-dialog__header">
          <div>
            <p>{t('eyebrow')}</p>
            <h2 id="account-dialog-title">{t('title', { provider: providerLabel })}</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="button button--quiet account-dialog__close"
            aria-label={common('close')}
            onClick={close}
          >
            <span className="account-dialog__close-glyph" aria-hidden="true">
              ×
            </span>
          </button>
        </header>

        <div className="account-dialog__body">
          <p role="status" aria-live="polite">
            {stateMessage(snapshot, effectiveError, t, providerLabel, accountProvider.id)}
          </p>
          {qrImage && (
            <div className="account-dialog__qr">
              <img src={qrImage} alt={t('scanAlt', { provider: providerLabel })} />
            </div>
          )}
          {canReopen && (
            <small className="account-dialog__notice">{t('mobileCurrentQrNotice')}</small>
          )}
          {canStart && hasLoginAction && (
            <small className="account-dialog__notice">
              {t(
                canStartQrLogin || visibleLoginMethods[0]?.flow === 'qr'
                  ? 'qrNotice'
                  : usesQqMusicPhoneLogin
                    ? 'mobileQqNotice'
                    : 'oauthNotice',
                {
                  provider: providerLabel,
                },
              )}
            </small>
          )}
          {canStart && !hasLoginAction && (
            <small className="account-dialog__notice">{t('noMethods')}</small>
          )}
          {busy && <small>{t('busy')}</small>}
        </div>

        <footer className="account-dialog__actions">
          {canReopen && (
            <button
              type="button"
              className="button button--primary"
              disabled={busy}
              onClick={() => void reopenLogin(accountProvider)}
            >
              {t('reopenQqMusicApp')}
            </button>
          )}
          {canStartQrLogin && (
            <button
              type="button"
              className="button button--primary"
              disabled={busy}
              onClick={() => void startQrLogin(accountProvider)}
            >
              {t('signInQr')}
            </button>
          )}
          {canStart &&
            visibleLoginMethods.map((method, index) => (
              <button
                key={method.id}
                type="button"
                className={`button ${index === 0 ? 'button--primary' : 'button--secondary'}`}
                disabled={busy}
                onClick={() =>
                  void (method.flow === 'qr'
                    ? startQrLogin(accountProvider)
                    : startLogin(accountProvider, method.id))
                }
              >
                {method.id === 'qq'
                  ? terminal
                    ? t('retry')
                    : t(usesQqMusicPhoneLogin ? 'signInQqMusicApp' : 'signInQq')
                  : method.id === 'wechat'
                    ? t('signInWechat')
                    : method.flow === 'qr'
                      ? t('signInQr')
                      : method.label}
              </button>
            ))}
          {snapshot.state === 'expired' &&
            snapshot.capabilities.qrLogin &&
            !usesQqMusicPhoneLogin && (
              <button
                type="button"
                className="button button--secondary"
                disabled={busy}
                onClick={() => void refreshQr(accountProvider)}
              >
                {t('refresh')}
              </button>
            )}
          {waiting && (
            <button
              type="button"
              className="button button--secondary"
              disabled={busy}
              onClick={() => void cancelLogin(accountProvider)}
            >
              {t('cancel')}
            </button>
          )}
          {snapshot.state === 'authenticated' && (
            <button
              type="button"
              className="button button--secondary"
              disabled={busy}
              onClick={() => void signOut(accountProvider)}
            >
              {busy ? t('signingOut') : t('signOut')}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
