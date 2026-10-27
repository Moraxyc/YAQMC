import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AppUpdateCandidate } from '@yaqmc/client';
import {
  createElectronUpdaterPort,
  applyElectronUpdaterFlags,
  noopUpdaterPort,
} from './electron-updater-port';
import { RELEASES_API, type BuildIdentity } from './release-catalog';
import {
  downloadUpdateFile,
  isUpdateUrlAllowed,
  updateResponse,
  verifyUpdateFile,
} from './update-io';
const identity: BuildIdentity = {
  source: 'official-release',
  commit: 'a'.repeat(40),
  tag: 'v1.0.0',
  architecture: 'x64',
  packageKind: 'portable',
};
const bytes = Buffer.alloc(128 * 1024, 7);
const name = 'YAQMC-windows-x64-portable.exe';
const release = {
  id: 1,
  draft: false,
  prerelease: false,
  tag_name: 'v2.0.0',
  body: 'commits',
  assets: [
    {
      id: 2,
      name,
      size: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      browser_download_url: `https://github.com/YAQMC/YAQMC/releases/download/v2.0.0/${name}`,
    },
  ],
};

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'yaqmc-update-test-'));
  const fetcher = vi.fn(async (url: string) =>
    url.startsWith(RELEASES_API)
      ? new Response(JSON.stringify(url.includes('?') ? [release] : release))
      : new Response(bytes, { headers: { 'content-length': String(bytes.length) } }),
  );
  const installNative = vi.fn(async (_candidate: AppUpdateCandidate, _file: string) => undefined);
  const port = createElectronUpdaterPort({
    identity,
    currentVersion: '1.0.0',
    fetcher,
    directory,
    installNative,
  });
  const result = await port.checkForUpdates();
  if (result.outcome !== 'available' || !result.candidate) throw new Error('fixture candidate');
  return { directory, fetcher, installNative, port, candidate: result.candidate };
}
describe('release transport and package integrity', () => {
  it('streams and verifies a package, revalidates the release and installs the fixed path', async () => {
    const f = await fixture();
    const progress = vi.fn();
    await f.port.downloadUpdate({
      candidate: f.candidate,
      signal: new AbortController().signal,
      progress,
      verifying: vi.fn(),
    });
    expect(f.installNative).not.toHaveBeenCalled();
    await f.port.installUpdate();
    const file = f.installNative.mock.calls[0]?.[1];
    expect(await readFile(file!)).toEqual(bytes);
    expect(progress).toHaveBeenLastCalledWith({
      transferred: bytes.length,
      total: bytes.length,
      percent: 100,
    });
    expect(f.fetcher.mock.calls.filter(([url]) => url === `${RELEASES_API}/1`)).toHaveLength(2);
  });
  it('rejects changed releases before downloading and changed files before installing', async () => {
    const f = await fixture();
    f.fetcher.mockImplementationOnce(
      async () => new Response(JSON.stringify({ ...release, assets: [] })),
    );
    await expect(
      f.port.downloadUpdate({
        candidate: f.candidate,
        signal: new AbortController().signal,
        progress: vi.fn(),
        verifying: vi.fn(),
      }),
    ).rejects.toThrow('update-release-changed');
    await f.port.downloadUpdate({
      candidate: f.candidate,
      signal: new AbortController().signal,
      progress: vi.fn(),
      verifying: vi.fn(),
    });
    const files = await readdir(f.directory);
    const file = path.join(f.directory, files[0]!);
    await writeFile(file, Buffer.alloc(bytes.length, 4));
    await expect(f.port.installUpdate()).rejects.toThrow('update-hash-mismatch');
    expect(f.installNative).not.toHaveBeenCalled();
  });
  it('deletes partial data on hash errors, oversized downloads and cancellation', async () => {
    const f = await fixture();
    for (const mode of ['hash', 'size', 'cancel']) {
      const controller = new AbortController();
      const fetcher = async () => {
        if (mode === 'cancel') controller.abort();
        return new Response(
          mode === 'size'
            ? Buffer.concat([bytes, Buffer.from('x')])
            : Buffer.alloc(bytes.length, 3),
        );
      };
      await expect(
        downloadUpdateFile({
          fetcher,
          candidate: f.candidate,
          directory: f.directory,
          signal: controller.signal,
          progress: vi.fn(),
        }),
      ).rejects.toThrow();
      expect((await readdir(f.directory)).filter((file) => file.endsWith('.part'))).toHaveLength(0);
    }
    const wrong = path.join(f.directory, 'wrong');
    await writeFile(wrong, 'short');
    await expect(verifyUpdateFile(wrong, f.candidate.asset!)).rejects.toThrow(
      'update-size-mismatch',
    );
  });
  it('fails before fetching when staging is unwritable or the declared package exceeds disk space', async () => {
    const f = await fixture();
    const fetcher = vi.fn(async () => new Response(bytes));
    await expect(
      downloadUpdateFile({
        fetcher,
        candidate: {
          ...f.candidate,
          asset: { ...f.candidate.asset!, size: Number.MAX_SAFE_INTEGER },
        },
        directory: f.directory,
        signal: new AbortController().signal,
        progress: vi.fn(),
      }),
    ).rejects.toThrow('update-insufficient-disk-space');
    const blocked = path.join(f.directory, 'not-a-directory');
    await writeFile(blocked, 'keep');
    await expect(
      downloadUpdateFile({
        fetcher,
        candidate: f.candidate,
        directory: blocked,
        signal: new AbortController().signal,
        progress: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readFile(blocked, 'utf8')).toBe('keep');
  });
  it('validates every redirect and omits provider credentials', async () => {
    expect(
      isUpdateUrlAllowed(
        'https://release-assets.githubusercontent.com/github-production-release-asset/file',
      ),
    ).toBe(true);
    for (const url of [
      'http://github.com/file',
      'https://github.com.evil.invalid/file',
      'https://127.0.0.1/file',
      'https://token@github.com/file',
    ]) {
      expect(isUpdateUrlAllowed(url)).toBe(false);
    }
    const redirect = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
    );
    await expect(
      updateResponse(
        redirect,
        'https://github.com/YAQMC/YAQMC/releases/download/v2/a',
        new AbortController().signal,
      ),
    ).rejects.toThrow('update-redirect-denied');
    expect(redirect).toHaveBeenCalledTimes(1);
    const good = vi.fn(async () => new Response('ok'));
    await updateResponse(
      good,
      'https://api.github.com/repos/YAQMC/YAQMC/releases',
      new AbortController().signal,
    );
    expect(good).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ credentials: 'omit', redirect: 'manual' }),
    );
  });
  it('never disables a configured publisher verifier and keeps automatic downloads off', async () => {
    const verifier = vi.fn();
    const flags = {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowPrerelease: true,
      verifyUpdateCodeSignature: verifier,
    };
    applyElectronUpdaterFlags(flags, 'latest');
    expect(flags).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: false,
      verifyUpdateCodeSignature: verifier,
    });
    await expect(noopUpdaterPort().checkForUpdates()).resolves.toEqual({
      outcome: 'not-available',
    });
  });
});
