import { createRequire } from 'node:module';
import { rm } from 'node:fs/promises';
import type { AppUpdateCandidate } from '@yaqmc/client';
import {
  RELEASES_API,
  compareVersions,
  releaseCandidate,
  selectRelease,
  type BuildIdentity,
} from './release-catalog';
import {
  downloadUpdateFile,
  isUpdateUrlAllowed,
  updateJson,
  verifyUpdateFile,
  type UpdateFetch,
} from './update-io';
import { electronUpdaterFlags, type DownloadContext, type UpdaterPort } from './updater';

type AutoUpdater = {
  netSession?: {
    webRequest: {
      onBeforeRequest(
        filter: { urls: string[] },
        listener: (
          details: { url: string },
          callback: (result: { cancel: boolean }) => void,
        ) => void,
      ): void;
    };
  };
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  disableDifferentialDownload: boolean;
  autoRunAppAfterInstall: boolean;
  channel: string | null;
  on(name: string, callback: (...args: unknown[]) => void): void;
  removeListener(name: string, callback: (...args: unknown[]) => void): void;
  setFeedURL(options: { provider: 'generic'; url: string; channel: string }): void;
  checkForUpdates(): Promise<{
    updateInfo: { version: string; files: { url: string; size?: number; sha512: string }[] };
  } | null>;
  downloadUpdate(token?: { cancel(): void }): Promise<string[]>;
  quitAndInstall(silent: boolean, forceRun: boolean): void;
};
export function applyElectronUpdaterFlags(
  updater: Pick<AutoUpdater, 'autoDownload' | 'autoInstallOnAppQuit' | 'allowPrerelease'>,
  channel: string,
) {
  Object.assign(updater, electronUpdaterFlags(channel));
}

export type ReleasePortOptions = {
  currentVersion: string;
  identity: BuildIdentity;
  fetcher: UpdateFetch;
  directory: string;
  installNative: (candidate: AppUpdateCandidate, file: string) => Promise<void>;
  createNsis?: () => AutoUpdater;
  beforeNsisInstall?: (candidate: AppUpdateCandidate) => Promise<void>;
};

export function createElectronUpdaterPort(options: ReleasePortOptions): UpdaterPort {
  let nsis: AutoUpdater | undefined;
  let downloaded: { candidate: AppUpdateCandidate; file: string } | undefined;
  let installerError: unknown;
  const fetchRelease = async (candidate: AppUpdateCandidate, signal: AbortSignal) => {
    const current = releaseCandidate(
      await updateJson(options.fetcher, `${RELEASES_API}/${candidate.releaseId}`, signal),
      options.currentVersion,
      true,
      options.identity,
    );
    if (current?.id !== candidate.id) throw new Error('update-release-changed');
  };
  return {
    async checkForUpdates(request) {
      const signal = request?.signal ?? AbortSignal.timeout(30_000);
      let candidate: AppUpdateCandidate | undefined;
      for (let page = 1; page <= 10; page++) {
        const list = await updateJson(
          options.fetcher,
          `${RELEASES_API}?per_page=30&page=${page}`,
          signal,
        );
        if (!Array.isArray(list)) throw new Error('update-response-invalid');
        const pageCandidate = selectRelease(
          list,
          options.currentVersion,
          request?.includePrerelease ?? false,
          options.identity,
        );
        if (
          pageCandidate &&
          (!candidate || compareVersions(pageCandidate.version, candidate.version) === 1)
        ) {
          candidate = pageCandidate;
        }
        if (list.length < 30) break;
      }
      return candidate
        ? {
            outcome: 'available',
            version: candidate.version,
            releaseUrl: candidate.releaseUrl,
            candidate,
          }
        : { outcome: 'not-available' };
    },
    async downloadUpdate(context?: DownloadContext) {
      if (!context?.candidate.asset) throw new Error('update-candidate-missing');
      downloaded = undefined;
      const { candidate } = context;
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15 * 60_000)]);
      const asset = candidate.asset!;
      await fetchRelease(candidate, signal);
      let file: string;
      if (options.identity.packageKind === 'nsis') {
        if (!asset.metadataUrl) throw new Error('missing-update-metadata');
        const require = createRequire(import.meta.url);
        nsis =
          options.createNsis?.() ??
          new (
            require('electron-updater') as {
              NsisUpdater: new () => AutoUpdater;
            }
          ).NsisUpdater();
        installerError = undefined;
        nsis.netSession?.webRequest.onBeforeRequest(
          { urls: ['<all_urls>'] },
          (request, callback) => {
            callback({ cancel: !isUpdateUrlAllowed(request.url) });
          },
        );
        nsis.on('error', (error) => {
          installerError = error;
        });
        applyElectronUpdaterFlags(nsis, 'latest');
        nsis.autoRunAppAfterInstall = true;
        nsis.allowPrerelease = true;
        nsis.disableDifferentialDownload = true;
        const channel = `updater-windows-${options.identity.architecture}`;
        nsis.setFeedURL({
          provider: 'generic',
          url: asset.metadataUrl.slice(0, asset.metadataUrl.lastIndexOf('/') + 1),
          channel,
        });
        nsis.channel = channel;
        nsis.allowDowngrade = false;
        const result = await abortable(nsis.checkForUpdates(), signal);
        signal.throwIfAborted();
        const files = result?.updateInfo.files;
        if (
          result?.updateInfo.version !== candidate.version ||
          files?.length !== 1 ||
          files[0]?.url !== asset.name ||
          files[0]?.size !== asset.size ||
          !/^[A-Za-z0-9+/]{86}==$/u.test(files[0]?.sha512 ?? '')
        ) {
          throw new Error('update-metadata-mismatch');
        }
        const cancellation = new (
          require('builder-util-runtime') as {
            CancellationToken: new () => { cancel(): void };
          }
        ).CancellationToken();
        const cancel = () => cancellation.cancel();
        const progress = (input: unknown) => {
          const p = input as { transferred: number; total: number; percent: number };
          context.progress({ transferred: p.transferred, total: p.total, percent: p.percent });
        };
        signal.addEventListener('abort', cancel, { once: true });
        nsis.on('download-progress', progress);
        try {
          const paths = await nsis.downloadUpdate(cancellation);
          if (!paths[0]) throw new Error('update-download-failed');
          file = paths[0];
        } finally {
          signal.removeEventListener('abort', cancel);
          nsis.removeListener('download-progress', progress);
        }
      } else {
        file = await downloadUpdateFile({
          ...context,
          fetcher: options.fetcher,
          directory: options.directory,
        });
      }
      try {
        context.verifying();
        await verifyUpdateFile(file, asset, signal);
        await fetchRelease(candidate, signal);
        downloaded = { candidate, file };
      } catch (error) {
        await rm(file, { force: true });
        throw error;
      }
    },
    async installUpdate() {
      if (!downloaded?.candidate.asset) throw new Error('update-download-missing');
      await verifyUpdateFile(downloaded.file, downloaded.candidate.asset);
      if (options.identity.packageKind === 'nsis') {
        if (!nsis) throw new Error('update-installer-missing');
        await options.beforeNsisInstall?.(downloaded.candidate);
        installerError = undefined;
        nsis.quitAndInstall(true, true);
        if (installerError) throw installerError;
      } else await options.installNative(downloaded.candidate, downloaded.file);
    },
  };
}

export function noopUpdaterPort(): UpdaterPort {
  return {
    checkForUpdates: async () => ({ outcome: 'not-available' }),
    downloadUpdate: async () => undefined,
    installUpdate: () => undefined,
  };
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let aborted: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        aborted = () => reject(signal.reason);
        signal.addEventListener('abort', aborted, { once: true });
      }),
    ]);
  } finally {
    if (aborted) signal.removeEventListener('abort', aborted);
  }
}
