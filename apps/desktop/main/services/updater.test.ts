import { describe, expect, it, vi } from 'vitest';
import type { AppUpdateCandidate, UpdatePayload } from '@yaqmc/client';
import { createUpdater, CHECK_DELAY_MS, CHECK_INTERVAL_MS, type UpdaterPort } from './updater';
import type { BuildIdentity } from './release-catalog';

const candidate: AppUpdateCandidate = {
  id: 'fixed',
  releaseId: 1,
  tag: 'v2.0.0',
  version: '2.0.0',
  releaseUrl: 'https://github.com/YAQMC/YAQMC/releases/tag/v2.0.0',
  notes: 'commits',
  asset: {
    id: 2,
    name: 'YAQMC-windows-x64-portable.exe',
    size: 123,
    sha256: 'a'.repeat(64),
    url: 'https://github.com/package',
  },
};
const identity: BuildIdentity = {
  source: 'official-release',
  tag: 'v1.0.0',
  commit: 'a'.repeat(40),
  architecture: 'x64',
  packageKind: 'portable',
};
function fixture(overrides: Partial<Parameters<typeof createUpdater>[0]> = {}) {
  const emitted: UpdatePayload[] = [];
  const port: UpdaterPort = {
    checkForUpdates: vi.fn(async () => ({
      outcome: 'available' as const,
      version: candidate.version,
      candidate,
    })),
    downloadUpdate: vi.fn(async () => undefined),
    installUpdate: vi.fn(async () => undefined),
  };
  const updater = createUpdater({
    port,
    identity,
    platform: 'win32',
    currentVersion: '1.0.0',
    channel: 'latest',
    emit: (_, body) => emitted.push(body),
    ...overrides,
  });
  return { updater, port, emitted };
}
async function available(updater: ReturnType<typeof createUpdater>) {
  expect((await updater.check()).state).toBe('checking');
  await vi.waitFor(() => expect(updater.state()).toBe('available'));
}

describe('application update lifecycle', () => {
  it('also returns operation IDs immediately from the legacy two-step controls', async () => {
    const { updater } = fixture();
    await available(updater);
    const downloading = await updater.download();
    expect(downloading.state).toBe('downloading');
    expect(downloading.operationId).toBeTruthy();
    await vi.waitFor(() => expect(updater.state()).toBe('ready-to-install'));
    expect((await updater.install()).state).toBe('waiting-to-restart');
    await vi.waitFor(() => expect(updater.state()).toBe('restarting'));
  });
  it('only notifies on checks, then completes the explicit one-click flow in order', async () => {
    const prepare = vi.fn(async () => undefined);
    const { updater, port, emitted } = fixture({ prepareInstall: prepare });
    await available(updater);
    expect(port.downloadUpdate).not.toHaveBeenCalled();
    expect(port.installUpdate).not.toHaveBeenCalled();
    expect((await updater.start(candidate.id)).state).toBe('downloading');
    await vi.waitFor(() => expect(updater.state()).toBe('restarting'));
    expect(emitted.map((p) => p.state)).toEqual([
      'checking',
      'available',
      'downloading',
      'ready-to-install',
      'waiting-to-restart',
      'installing',
      'restarting',
    ]);
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(port.installUpdate).mock.invocationCallOrder[0]!,
    );
  });
  it.each(['source', 'unknown'] as const)('keeps %s builds notification-only', async (source) => {
    const { updater, port } = fixture({ identity: { ...identity, source } });
    await available(updater);
    expect(updater.payload().installDisabledReason).toBe('non-release-build');
    await expect(updater.start(candidate.id)).rejects.toThrow('non-release-build');
    await updater.download();
    expect(port.downloadUpdate).not.toHaveBeenCalled();
  });
  it('keeps package-manager and archive installations notification-only', async () => {
    const { updater } = fixture({
      platform: 'linux',
      identity: { ...identity, packageKind: 'managed' },
    });
    await available(updater);
    expect(updater.payload().canInstall).toBe(false);
  });
  it('refuses stale candidates, serializes clicks and cancels a download before stopping Core', async () => {
    const prepare = vi.fn();
    let finish: (() => void) | undefined;
    const port: UpdaterPort = {
      checkForUpdates: async () => ({
        outcome: 'available',
        version: candidate.version,
        candidate,
      }),
      downloadUpdate: vi.fn(
        (context) =>
          new Promise<void>((_, reject) => {
            finish = () => reject(new Error('aborted'));
            context!.signal.addEventListener('abort', finish, { once: true });
          }),
      ),
      installUpdate: vi.fn(),
    };
    const { updater } = fixture({ port, prepareInstall: prepare });
    await available(updater);
    await expect(updater.start('arbitrary')).rejects.toThrow('update-candidate-stale');
    await updater.start(candidate.id);
    await updater.start(candidate.id);
    expect(port.downloadUpdate).toHaveBeenCalledTimes(1);
    await updater.cancel();
    await vi.waitFor(() => expect(updater.state()).toBe('cancelled'));
    expect(prepare).not.toHaveBeenCalled();
    expect(port.installUpdate).not.toHaveBeenCalled();
  });
  it('never installs after failed verification or shutdown preparation', async () => {
    const { updater, port } = fixture({
      prepareInstall: async () => {
        throw new Error('pending plugin transaction');
      },
    });
    await available(updater);
    await updater.start(candidate.id);
    await vi.waitFor(() => expect(updater.state()).toBe('error'));
    expect(port.installUpdate).not.toHaveBeenCalled();
    expect(updater.payload().error).toContain('pending plugin transaction');
  });
  it('persists the prerelease opt-in and invalidates the old review', async () => {
    const persist = vi.fn();
    const { updater, port } = fixture({ persistPreferences: persist });
    await available(updater);
    await updater.preferences(true);
    await vi.waitFor(() => expect(updater.state()).toBe('available'));
    expect(persist).toHaveBeenCalledWith({ includePrerelease: true });
    expect(port.checkForUpdates).toHaveBeenLastCalledWith(
      expect.objectContaining({ includePrerelease: true }),
    );
  });
  it('schedules one launch check and subsequent daily checks without downloads', () => {
    const schedule = vi.fn();
    const { updater, port } = fixture({ scheduleCheck: schedule });
    updater.scheduleLaunchCheck();
    updater.scheduleLaunchCheck();
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0]?.[1]).toBe(CHECK_DELAY_MS);
    schedule.mock.calls[0]?.[0]();
    expect(schedule.mock.calls[1]?.[1]).toBe(CHECK_INTERVAL_MS);
    expect(port.downloadUpdate).not.toHaveBeenCalled();
  });
});
