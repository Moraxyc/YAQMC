import { CHANNEL_HOST_UPDATE, type UpdatePayload, type UpdateState } from '@yaqmc/client';
import { Download, ExternalLink, RefreshCw, RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { getYaqmcClient } from '../application/yaqmc-runtime';

/** Host-only methods Main registers in UPD-01. Not in METHOD_NAMES. */
export const HOST_UPDATER_CHECK_METHOD = 'host_updater_check';
export const HOST_UPDATER_DOWNLOAD_METHOD = 'host_updater_download';
export const HOST_UPDATER_INSTALL_METHOD = 'host_updater_install';

export const NOT_WIRED_ERROR = 'Updater check is not wired yet';

export const IDLE_UPDATE_PAYLOAD: UpdatePayload = {
  state: 'idle',
  canInstall: false,
  allowPrerelease: false,
  channel: 'latest',
};

type HostInvokeSeam = {
  invoke: (method: string) => Promise<unknown>;
};

export function isUpdateCheckBusy(state: UpdateState): boolean {
  return [
    'checking',
    'downloading',
    'verifying',
    'waiting-to-restart',
    'installing',
    'restarting',
  ].includes(state);
}

export function notWiredUpdatePayload(): UpdatePayload {
  return {
    ...IDLE_UPDATE_PAYLOAD,
    state: 'error',
    error: NOT_WIRED_ERROR,
  };
}

export async function requestHostUpdateCheck(client: HostInvokeSeam): Promise<void> {
  await client.invoke(HOST_UPDATER_CHECK_METHOD);
}

export async function requestHostUpdateDownload(client: HostInvokeSeam): Promise<void> {
  await client.invoke(HOST_UPDATER_DOWNLOAD_METHOD);
}

export async function requestHostUpdateInstall(client: HostInvokeSeam): Promise<void> {
  await client.invoke(HOST_UPDATER_INSTALL_METHOD);
}

export function updateStatusCopy(payload: UpdatePayload): string {
  const t = i18n.getFixedT(null, 'settings', 'updates');
  switch (payload.state) {
    case 'checking':
      return t('checking');
    case 'available':
      if (!payload.canInstall) {
        return payload.version
          ? t('availableManualVersion', { version: payload.version })
          : t('availableManual');
      }
      return payload.version ? t('availableVersion', { version: payload.version }) : t('available');
    case 'not-available':
      return t('latest');
    case 'downloading':
      return t('downloading');
    case 'ready-to-install':
      return t('ready');
    case 'verifying':
      return t('verifying');
    case 'waiting-to-restart':
      return t('waitingRestart');
    case 'installing':
      return t('installing');
    case 'restarting':
      return t('restarting');
    case 'completed':
      return t('completed');
    case 'cancelled':
      return t('cancelled');
    case 'rolled-back':
      return t('rolledBack');
    case 'error':
      return payload.error === NOT_WIRED_ERROR
        ? t('notWired')
        : payload.error === 'update-download-failed'
          ? t('downloadFailed')
          : payload.error === 'update-install-failed'
            ? t('installFailed')
            : (payload.error ?? t('checkFailed'));
    default:
      return t('idle');
  }
}

export function SettingsUpdateSection({ mode = 'install' }: { mode?: 'install' | 'notify' }) {
  const { t } = useTranslation('settings', { keyPrefix: 'updates' });
  const [payload, setPayload] = useState<UpdatePayload>(IDLE_UPDATE_PAYLOAD);
  const notifyOnly = mode === 'notify';
  const eventRevision = useRef(0);

  useEffect(() => {
    let disposed = false;
    const client = getYaqmcClient();
    const unlisten = client.on(CHANNEL_HOST_UPDATE, (next) => {
      eventRevision.current += 1;
      setPayload(next);
    });
    const refresh = async () => {
      const revision = eventRevision.current;
      try {
        const value = await client.invoke('host_updater_status');
        if (!disposed && revision === eventRevision.current && value?.state) setPayload(value);
      } catch {
        /* Older and Android hosts deliver update status through events. */
      }
    };
    if (!notifyOnly) void refresh();
    const timer = notifyOnly ? undefined : setInterval(() => void refresh(), 1000);
    return () => {
      disposed = true;
      unlisten();
      if (timer) clearInterval(timer);
    };
  }, [notifyOnly]);

  const check = async () => {
    if (isUpdateCheckBusy(payload.state)) return;
    setPayload((current) => ({ ...current, state: 'checking', error: undefined }));
    try {
      await requestHostUpdateCheck(getYaqmcClient() as unknown as HostInvokeSeam);
    } catch {
      setPayload(notWiredUpdatePayload());
    }
  };

  const download = async () => {
    if (!['available', 'error', 'cancelled'].includes(payload.state) || !payload.canInstall) return;
    try {
      if (payload.candidate) {
        const result = await getYaqmcClient().invoke('host_updater_start', {
          candidateId: payload.candidate.id,
        });
        setPayload(result);
      } else await requestHostUpdateDownload(getYaqmcClient() as unknown as HostInvokeSeam);
    } catch {
      setPayload((current) => ({
        ...current,
        state: 'error',
        error: 'update-download-failed',
      }));
    }
  };

  const install = async () => {
    if (payload.state !== 'ready-to-install' || !payload.canInstall) return;
    try {
      await requestHostUpdateInstall(getYaqmcClient() as unknown as HostInvokeSeam);
    } catch {
      setPayload((current) => ({
        ...current,
        state: 'error',
        error: 'update-install-failed',
      }));
    }
  };

  const openRelease = async () => {
    const url = payload.releaseUrl;
    if (!url) return;
    await getYaqmcClient().host.shell.openExternal(url);
  };

  const busy = isUpdateCheckBusy(payload.state);
  const showDownload =
    !notifyOnly &&
    ['available', 'error', 'cancelled'].includes(payload.state) &&
    payload.canInstall;
  const showReleaseLink = Boolean(payload.releaseUrl);
  const showInstall = !notifyOnly && payload.state === 'ready-to-install' && payload.canInstall;
  const size = (bytes: number) =>
    `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MiB`;
  const reason =
    payload.installDisabledReason === 'non-release-build'
      ? 'reasonSource'
      : payload.installDisabledReason === 'managed-installation'
        ? 'reasonManaged'
        : ['unsupported-architecture', 'unsupported-package'].includes(
              payload.installDisabledReason ?? '',
            )
          ? 'reasonPackage'
          : 'reasonAsset';

  return (
    <section className="settings-section">
      <div className="settings-section__heading">
        <div>
          <h2>{t('title')}</h2>
          <p>{notifyOnly ? t('androidReleaseDescription') : t('description')}</p>
        </div>
      </div>
      <div className="settings-card">
        {payload.currentVersion && (
          <div className="settings-row settings-row--update-summary">
            <div>
              <strong>{t('currentVersion', { version: payload.currentVersion })}</strong>
              <span>
                {t(payload.buildSource === 'official-release' ? 'sourceOfficial' : 'sourceOther')}
                {payload.packageKind
                  ? ` · ${
                      payload.packageKind === 'AppImage'
                        ? 'AppImage'
                        : t(
                            payload.packageKind === 'nsis'
                              ? 'packageInstaller'
                              : payload.packageKind === 'portable'
                                ? 'packagePortable'
                                : 'packageManaged',
                          )
                    }`
                  : ''}
              </span>
              {payload.candidate && (
                <span>
                  {t('candidateVersion', {
                    version: payload.candidate.version,
                    size: payload.candidate.asset ? size(payload.candidate.asset.size) : '—',
                  })}
                </span>
              )}
              {payload.installDisabledReason && payload.state === 'available' && (
                <span>{t(reason)}</span>
              )}
            </div>
          </div>
        )}
        {!notifyOnly && payload.buildSource && (
          <div className="settings-row">
            <div>
              <strong>{t('prerelease')}</strong>
              <span>{t('prereleaseDescription')}</span>
            </div>
            <input
              type="checkbox"
              aria-label={t('prerelease')}
              checked={payload.allowPrerelease}
              disabled={busy || showInstall}
              onChange={(event) => {
                void getYaqmcClient()
                  .invoke('host_updater_preferences', { includePrerelease: event.target.checked })
                  .then(setPayload)
                  .catch((error) =>
                    setPayload((current) => ({ ...current, state: 'error', error: String(error) })),
                  );
              }}
            />
          </div>
        )}
        <div className="settings-row">
          <div>
            <strong>{t('check')}</strong>
            <span
              data-update-state={payload.state}
              role={payload.state === 'error' ? 'alert' : 'status'}
            >
              {updateStatusCopy(payload)}
            </span>
          </div>
          <button
            type="button"
            className="button button--secondary"
            disabled={busy}
            onClick={() => void check()}
          >
            <RefreshCw size={14} /> {t('check')}
          </button>
        </div>
        {payload.progress && busy && (
          <div className="settings-row settings-row--update-progress">
            <div>
              <progress aria-label={t('progress')} max={100} value={payload.progress.percent} />
              <span>
                {size(payload.progress.transferred)} / {size(payload.progress.total)} ·{' '}
                {Math.floor(payload.progress.percent)}%
              </span>
            </div>
            {payload.canCancel && (
              <button
                type="button"
                className="button button--quiet"
                onClick={() => void getYaqmcClient().invoke('host_updater_cancel').then(setPayload)}
              >
                {t('cancel')}
              </button>
            )}
          </div>
        )}
        {showDownload ? (
          <div className="settings-row">
            <div>
              <strong>{t('download')}</strong>
              <span>{t('downloadDescription')}</span>
            </div>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => void download()}
            >
              <Download size={14} /> {t('downloadAction')}
            </button>
          </div>
        ) : null}
        {showReleaseLink ? (
          <div className="settings-row">
            <div>
              <strong>{t('release')}</strong>
              <span>{notifyOnly ? t('androidReleaseDescription') : t('releaseDescription')}</span>
              {payload.releaseNotes ? (
                <details className="settings-update-notes">
                  <summary>{t('commits')}</summary>
                  <ReleaseCommitNotes notes={payload.releaseNotes} />
                </details>
              ) : null}
            </div>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => void openRelease()}
            >
              <ExternalLink size={14} /> {t('releaseAction')}
            </button>
          </div>
        ) : null}
        {showInstall ? (
          <div className="settings-row">
            <div>
              <strong>{t('install')}</strong>
              <span>{t('installDescription')}</span>
            </div>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => void install()}
            >
              <RotateCw size={14} /> {t('install')}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ReleaseCommitNotes({ notes }: { notes: string }) {
  const { t } = useTranslation('settings', { keyPrefix: 'updates' });
  const fullList =
    /\[完整列表 \/ Full list\]\((https:\/\/github\.com\/YAQMC\/YAQMC\/releases\/download\/[A-Za-z0-9%+._-]+\/COMMITS\.md)\)/u.exec(
      notes,
    )?.[1];
  const commits = notes.split('\n').flatMap((line) => {
    const match =
      /^- \[([a-f0-9]{7,40})\]\((https:\/\/github\.com\/YAQMC\/YAQMC\/commit\/[a-f0-9]{40})\) (.*)$/u.exec(
        line,
      );
    if (!match) return [];
    const title = match[3]!
      .replace(/\\([\\`*_{}[\]()#+!|])/gu, '$1')
      .replace(/&lt;/gu, '<')
      .replace(/&gt;/gu, '>')
      .replace(/&amp;/gu, '&');
    return [{ sha: match[1]!, url: match[2]!, title }];
  });
  if (!commits.length)
    return <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{notes}</p>;
  return (
    <>
      <ul>
        {commits.map((commit) => (
          <li key={commit.url}>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => void getYaqmcClient().host.shell.openExternal(commit.url)}
            >
              {commit.sha}
            </button>{' '}
            {commit.title}
          </li>
        ))}
      </ul>
      {fullList && (
        <p>
          {t('commitsTruncated')}{' '}
          <button
            type="button"
            className="button button--quiet"
            onClick={() => void getYaqmcClient().host.shell.openExternal(fullList)}
          >
            {t('fullCommits')}
          </button>
        </p>
      )}
    </>
  );
}
