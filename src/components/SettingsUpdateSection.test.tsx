import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdateCandidate, UpdatePayload } from '@yaqmc/client';
import i18n from '../i18n';
import {
  IDLE_UPDATE_PAYLOAD,
  SettingsUpdateSection,
  isUpdateCheckBusy,
} from './SettingsUpdateSection';
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  handler: undefined as ((value: UpdatePayload) => void) | undefined,
}));
vi.mock('../application/yaqmc-runtime', () => ({
  getYaqmcClient: () => ({
    invoke: mocks.invoke,
    on: (_channel: string, handler: (value: UpdatePayload) => void) => {
      mocks.handler = handler;
      return () => {
        mocks.handler = undefined;
      };
    },
    host: { shell: { openExternal: mocks.open } },
  }),
}));
const candidate: AppUpdateCandidate = {
  id: 'reviewed-id',
  releaseId: 1,
  tag: 'v1.2.0',
  version: '1.2.0',
  releaseUrl: 'https://github.com/YAQMC/YAQMC/releases/tag/v1.2.0',
  notes: '',
  asset: {
    id: 2,
    name: 'package',
    size: 1024 * 1024,
    sha256: 'a'.repeat(64),
    url: 'https://github.com/package',
  },
};
const payload = (extra: Partial<UpdatePayload> = {}): UpdatePayload => ({
  ...IDLE_UPDATE_PAYLOAD,
  currentVersion: '1.0.0',
  buildSource: 'official-release',
  ...extra,
});
beforeEach(async () => {
  mocks.invoke.mockReset();
  mocks.open.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
  await i18n.changeLanguage('en-US');
});
describe('application update controls', () => {
  it('restores a running operation on entry and displays progress without starting another task', async () => {
    mocks.invoke.mockResolvedValue(
      payload({
        state: 'downloading',
        progress: { transferred: 500, total: 1000, percent: 50 },
        canCancel: true,
      }),
    );
    render(<SettingsUpdateSection />);
    await screen.findByRole('progressbar', { name: 'Update download progress' });
    expect(screen.getByRole('button', { name: 'Cancel download' })).toBeVisible();
    expect(mocks.invoke).toHaveBeenCalledWith('host_updater_status');
    expect(mocks.invoke).not.toHaveBeenCalledWith('host_updater_start', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel download' }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('host_updater_cancel'));
  });
  it('starts the fixed candidate once and never sends arbitrary paths or a second install command', async () => {
    render(<SettingsUpdateSection />);
    act(() =>
      mocks.handler?.(
        payload({ state: 'available', canInstall: true, candidate, version: candidate.version }),
      ),
    );
    expect(screen.getByText('Current version: 1.0.0')).toBeVisible();
    expect(mocks.invoke).not.toHaveBeenCalledWith('host_updater_start', expect.anything());
    mocks.invoke.mockResolvedValue(payload({ state: 'downloading', canInstall: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Download, update and restart' }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('host_updater_start', {
        candidateId: 'reviewed-id',
      }),
    );
    expect(mocks.invoke).not.toHaveBeenCalledWith('host_updater_install');
  });
  it('persists the prerelease choice through the host', async () => {
    render(<SettingsUpdateSection />);
    act(() => mocks.handler?.(payload()));
    mocks.invoke.mockResolvedValue(payload({ state: 'checking', allowPrerelease: true }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Receive prereleases' }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('host_updater_preferences', {
        includePrerelease: true,
      }),
    );
  });
  it('keeps source and Android hosts notification-only', () => {
    render(<SettingsUpdateSection mode="notify" />);
    act(() =>
      mocks.handler?.(
        payload({
          state: 'available',
          canInstall: true,
          buildSource: 'source',
          version: '2.0.0',
          releaseUrl: candidate.releaseUrl,
          installDisabledReason: 'non-release-build',
        }),
      ),
    );
    expect(
      screen.queryByRole('button', { name: 'Download, update and restart' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Receive prereleases' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open release page' }));
    expect(mocks.open).toHaveBeenCalledWith(candidate.releaseUrl);
  });
  it('renders commit titles as text and only opens verified commit links', () => {
    const sha = 'a'.repeat(40);
    render(<SettingsUpdateSection />);
    act(() =>
      mocks.handler?.(
        payload({
          state: 'available',
          releaseUrl: candidate.releaseUrl,
          releaseNotes: `- [${sha.slice(0, 12)}](https://github.com/YAQMC/YAQMC/commit/${sha}) &lt;img src=x&gt; fix`,
        }),
      ),
    );
    fireEvent.click(screen.getByText('Commits in this release'));
    expect(screen.getByText('<img src=x> fix')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: sha.slice(0, 12) }));
    expect(mocks.open).toHaveBeenCalledWith(`https://github.com/YAQMC/YAQMC/commit/${sha}`);
  });
  it('localizes the one-click action and treats all installation stages as busy', async () => {
    render(<SettingsUpdateSection />);
    act(() => mocks.handler?.(payload({ state: 'available', canInstall: true, candidate })));
    await act(() => i18n.changeLanguage('zh-CN'));
    expect(screen.getByRole('button', { name: '下载、更新并重启' })).toBeVisible();
    for (const state of [
      'checking',
      'downloading',
      'verifying',
      'waiting-to-restart',
      'installing',
      'restarting',
    ] as const)
      expect(isUpdateCheckBusy(state)).toBe(true);
  });
  it('keeps the truncation notice and only links the official complete commit attachment', () => {
    const sha = 'a'.repeat(40);
    const fullList = 'https://github.com/YAQMC/YAQMC/releases/download/v1.2.0/COMMITS.md';
    render(<SettingsUpdateSection />);
    const updateNotes = (url: string) =>
      act(() =>
        mocks.handler?.(
          payload({
            state: 'available',
            releaseUrl: candidate.releaseUrl,
            releaseNotes: `- [${sha.slice(0, 12)}](https://github.com/YAQMC/YAQMC/commit/${sha}) fix\n\n提交列表已截断 / Commit list truncated. [完整列表 / Full list](${url})`,
          }),
        ),
      );
    updateNotes(fullList);
    fireEvent.click(screen.getByText('Commits in this release'));
    expect(screen.getByText('Only part of the commit list is shown here.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View all commits' }));
    expect(mocks.open).toHaveBeenCalledWith(fullList);
    updateNotes('https://untrusted.example/COMMITS.md');
    expect(screen.queryByRole('button', { name: 'View all commits' })).not.toBeInTheDocument();
  });
});
