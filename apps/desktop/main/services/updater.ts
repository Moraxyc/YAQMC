import { randomUUID } from 'node:crypto';
import {
  CHANNEL_HOST_UPDATE,
  type AppUpdateCandidate,
  type AppUpdateProgress,
  type UpdatePayload,
  type UpdateState,
} from '@yaqmc/client';
import { installDisabledReason, type BuildIdentity } from './release-catalog';

export { CHANNEL_HOST_UPDATE };
export type { UpdatePayload, UpdateState };
export const CHECK_DELAY_MS = 30_000;
export const CHECK_INTERVAL_MS = 86_400_000;
export const DEFAULT_RELEASE_URL = 'https://github.com/YAQMC/YAQMC/releases';
export type LinuxPackageKind = 'AppImage' | 'deb' | 'rpm' | 'tar.gz';
export type UpdaterCheckResult =
  | { outcome: 'available'; version: string; releaseUrl?: string; candidate?: AppUpdateCandidate }
  | { outcome: 'not-available' }
  | { outcome: 'error'; message: string };
export type DownloadContext = {
  candidate: AppUpdateCandidate;
  signal: AbortSignal;
  progress: (progress: AppUpdateProgress) => void;
  verifying: () => void;
};
export type UpdaterPort = {
  checkForUpdates(options?: {
    includePrerelease: boolean;
    signal: AbortSignal;
  }): Promise<UpdaterCheckResult>;
  downloadUpdate(context?: DownloadContext): Promise<void>;
  installUpdate(): Promise<void> | void;
};
export type ScheduleCheck = (callback: () => void, delayMs: number) => unknown;
export type UpdateEmit = (channel: typeof CHANNEL_HOST_UPDATE, payload: UpdatePayload) => void;
export type UpdaterOptions = {
  port: UpdaterPort;
  emit: UpdateEmit;
  channel: string;
  currentVersion?: string;
  identity?: BuildIdentity;
  platform?: NodeJS.Platform | string;
  linuxPackage?: LinuxPackageKind;
  env?: NodeJS.ProcessEnv;
  scheduleCheck?: ScheduleCheck;
  includePrerelease?: boolean;
  persistPreferences?: (value: { includePrerelease: boolean }) => void;
  prepareInstall?: () => Promise<void>;
  installationFailed?: () => Promise<void>;
  initialResult?: { state: 'completed' | 'rolled-back' | 'error'; error?: string };
};
export function allowPrereleaseForChannel(channel: string): boolean {
  return channel === 'nightly';
}
export function electronUpdaterFlags(channel: string) {
  return {
    autoDownload: false as const,
    autoInstallOnAppQuit: false as const,
    allowPrerelease: allowPrereleaseForChannel(channel),
  };
}
export function linuxPackageFromEnv(env: NodeJS.ProcessEnv): LinuxPackageKind | undefined {
  return env.APPIMAGE ? 'AppImage' : undefined;
}
export function canInstallInPlace(options: {
  platform: string;
  linuxPackage?: LinuxPackageKind;
}): boolean {
  return (
    options.platform === 'win32' ||
    (options.platform === 'linux' && options.linuxPackage === 'AppImage')
  );
}
export const UPDATE_BUSY_STATES: readonly UpdateState[] = [
  'checking',
  'downloading',
  'verifying',
  'waiting-to-restart',
  'installing',
  'restarting',
];
export type UpdaterHandle = {
  state(): UpdateState;
  payload(): UpdatePayload;
  scheduleLaunchCheck(): void;
  check(): Promise<UpdatePayload>;
  start(candidateId: string): Promise<UpdatePayload>;
  cancel(): Promise<UpdatePayload>;
  preferences(includePrerelease: boolean): Promise<UpdatePayload>;
  download(): Promise<UpdatePayload>;
  install(): Promise<UpdatePayload>;
};

export function createUpdater(options: UpdaterOptions): UpdaterHandle {
  const identity =
    options.identity ??
    ({
      source: 'unknown',
      commit: 'unknown',
      tag: '',
      architecture: process.arch,
      packageKind: 'managed',
    } satisfies BuildIdentity);
  let includePrerelease = options.includePrerelease ?? false;
  const baseReason = installDisabledReason(identity, options.platform ?? process.platform);
  let status: UpdatePayload = {
    state: options.initialResult?.state ?? 'idle',
    canInstall: !baseReason,
    allowPrerelease: includePrerelease,
    channel: includePrerelease ? 'prerelease' : 'latest',
    currentVersion: options.currentVersion,
    buildSource: identity.source,
    packageKind: identity.packageKind,
    buildCommit: identity.commit,
    releaseTag: identity.tag,
    installDisabledReason: baseReason,
    error: options.initialResult?.error,
  };
  let controller: AbortController | undefined;
  let scheduled = false;
  const payload = (): UpdatePayload => structuredClone(status);
  const emit = (state: UpdateState, patch: Partial<UpdatePayload> = {}): UpdatePayload => {
    status = {
      ...status,
      ...patch,
      state,
      canCancel: ['checking', 'downloading', 'verifying'].includes(state),
    };
    const next = payload();
    options.emit(CHANNEL_HOST_UPDATE, next);
    return next;
  };
  const busy = () => UPDATE_BUSY_STATES.includes(status.state);
  const check = async (): Promise<UpdatePayload> => {
    if (busy() || status.state === 'ready-to-install') return payload();
    controller = new AbortController();
    const signal = controller.signal;
    emit('checking', { operationId: randomUUID(), error: undefined, progress: undefined });
    void (async () => {
      try {
        const result = await options.port.checkForUpdates({ includePrerelease, signal });
        signal.throwIfAborted();
        if (result.outcome === 'error') throw new Error(result.message);
        if (result.outcome === 'not-available') {
          emit('not-available', {
            candidate: undefined,
            version: undefined,
            releaseUrl: undefined,
            releaseNotes: undefined,
            canInstall: !baseReason,
            installDisabledReason: baseReason,
          });
        } else {
          const candidate = result.candidate;
          const reason =
            baseReason ??
            (!candidate?.asset
              ? 'missing-verified-package'
              : identity.packageKind === 'nsis' && !candidate.asset.metadataUrl
                ? 'missing-update-metadata'
                : undefined);
          emit('available', {
            candidate,
            version: result.version,
            releaseUrl: result.releaseUrl ?? DEFAULT_RELEASE_URL,
            releaseNotes: candidate?.notes,
            canInstall: !reason,
            installDisabledReason: reason,
          });
        }
      } catch (error) {
        emit(signal.aborted ? 'cancelled' : 'error', {
          error: signal.aborted ? undefined : String(error),
        });
      }
    })();
    return payload();
  };
  const install = async () => {
    if (status.state !== 'ready-to-install' || !status.canInstall) return payload();
    emit('waiting-to-restart', { error: undefined });
    try {
      await options.prepareInstall?.();
      emit('installing');
      await options.port.installUpdate();
      return emit('restarting');
    } catch (error) {
      await options.installationFailed?.().catch(() => undefined);
      return emit('error', { error: String(error) });
    }
  };
  const download = async (autoInstall: boolean): Promise<UpdatePayload> => {
    if (
      busy() ||
      !status.canInstall ||
      !status.candidate ||
      !['available', 'error', 'cancelled'].includes(status.state)
    )
      return payload();
    const candidate = structuredClone(status.candidate);
    controller = new AbortController();
    const signal = controller.signal;
    emit('downloading', {
      operationId: randomUUID(),
      error: undefined,
      progress: { transferred: 0, total: candidate.asset?.size ?? 0, percent: 0 },
    });
    try {
      await options.port.downloadUpdate({
        candidate,
        signal,
        progress: (progress) => {
          if (!signal.aborted) emit(status.state, { progress });
        },
        verifying: () => {
          signal.throwIfAborted();
          emit('verifying');
        },
      });
      signal.throwIfAborted();
      emit('ready-to-install');
      if (autoInstall) return await install();
    } catch (error) {
      emit(signal.aborted ? 'cancelled' : 'error', {
        error: signal.aborted ? undefined : String(error),
      });
    }
    return payload();
  };
  return {
    state: () => status.state,
    payload,
    check,
    scheduleLaunchCheck() {
      if (scheduled) return;
      scheduled = true;
      const run = () => {
        void check();
        options.scheduleCheck?.(run, CHECK_INTERVAL_MS);
      };
      options.scheduleCheck?.(run, CHECK_DELAY_MS);
    },
    async start(candidateId) {
      if (busy()) return payload();
      if (candidateId !== status.candidate?.id) throw new Error('update-candidate-stale');
      if (!status.canInstall)
        throw new Error(status.installDisabledReason ?? 'update-not-supported');
      if (status.state === 'ready-to-install') void install();
      else void download(true);
      return payload();
    },
    async cancel() {
      if (status.canCancel) controller?.abort();
      return payload();
    },
    async preferences(value) {
      if (busy() || status.state === 'ready-to-install')
        throw new Error('update-operation-in-progress');
      if (typeof value !== 'boolean') throw new Error('update-preferences-invalid');
      options.persistPreferences?.({ includePrerelease: value });
      includePrerelease = value;
      emit('idle', {
        allowPrerelease: value,
        channel: value ? 'prerelease' : 'latest',
        candidate: undefined,
        version: undefined,
        releaseUrl: undefined,
        releaseNotes: undefined,
        error: undefined,
        progress: undefined,
        canInstall: !baseReason,
        installDisabledReason: baseReason,
      });
      return check();
    },
    async download() {
      void download(false);
      return payload();
    },
    async install() {
      void install();
      return payload();
    },
  };
}
