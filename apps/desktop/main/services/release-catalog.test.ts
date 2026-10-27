import { describe, expect, it } from 'vitest';
import {
  assetName,
  compareVersions,
  installDisabledReason,
  packageKind,
  releaseCandidate,
  selectRelease,
  type BuildIdentity,
} from './release-catalog';
const identity: BuildIdentity = {
  source: 'official-release',
  tag: 'v1.0.0',
  commit: 'a'.repeat(40),
  architecture: 'arm64',
  packageKind: 'portable',
};
function release(version: string, pre = false) {
  const tag = `v${version}`,
    name = assetName(identity)!;
  return {
    id: 1,
    tag_name: tag,
    draft: false,
    prerelease: pre,
    body: 'commits',
    assets: [
      {
        id: 2,
        name,
        size: 100,
        digest: `sha256:${'a'.repeat(64)}`,
        browser_download_url: `https://github.com/YAQMC/YAQMC/releases/download/${encodeURIComponent(tag)}/${name}`,
      },
    ],
  };
}
describe('release selection and distribution identity', () => {
  it('compares SemVer prereleases numerically and ignores build metadata', () => {
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0-beta.10')).toBe(1);
    expect(compareVersions('1.0.0+x', '1.0.0+y')).toBe(0);
    expect(compareVersions('legacy', '1.0.0')).toBeUndefined();
  });
  it('only selects higher published versions in the opted-in channel', () => {
    const releases = [
      release('2.0.0-beta.1', true),
      release('1.2.0'),
      release('1.1.0'),
      { ...release('3.0.0'), draft: true },
    ];
    expect(selectRelease(releases, '1.0.0', false, identity)?.version).toBe('1.2.0');
    expect(selectRelease(releases, '1.0.0', true, identity)?.version).toBe('2.0.0-beta.1');
    expect(selectRelease(releases, '2.0.0-beta.2', false, identity)).toBeUndefined();
    expect(releaseCandidate(release('1.0.0'), '1.0.0', true, identity)).toBeUndefined();
  });
  it('binds an exact architecture, package, asset size and GitHub digest', () => {
    const value = release('1.1.0');
    expect(releaseCandidate(value, '1.0.0', false, identity)?.asset?.name).toBe(
      'YAQMC-windows-arm64-portable.exe',
    );
    value.assets[0]!.name = 'YAQMC-windows-x64-portable.exe';
    expect(releaseCandidate(value, '1.0.0', false, identity)?.asset).toBeUndefined();
  });
  it('accepts legal build metadata without treating it as a version increase', () => {
    const candidate = releaseCandidate(release('1.1.0+ci.7'), '1.0.0', false, identity);
    expect(candidate?.version).toBe('1.1.0+ci.7');
    expect(candidate?.asset).toBeDefined();
    expect(releaseCandidate(release('1.0.0+ci.8'), '1.0.0+ci.7', true, identity)).toBeUndefined();
    expect(
      releaseCandidate(release('1.1.0-beta.1+ci.7', true), '1.0.0', true, identity)?.version,
    ).toBe('1.1.0-beta.1+ci.7');
    for (const invalid of ['v1.1.0', '01.1.0', '1.1.0+ci..7']) {
      expect(releaseCandidate(release(invalid), '1.0.0', true, identity)).toBeUndefined();
    }
  });
  it('does not grant install authority based on packaging or environment alone', () => {
    expect(
      packageKind({
        platform: 'win32',
        packaged: false,
        env: { PORTABLE_EXECUTABLE_FILE: 'C:\\a.exe' },
        hasInstallerIdentity: true,
      }),
    ).toBe('managed');
    expect(installDisabledReason({ ...identity, source: 'source' }, 'win32')).toBe(
      'non-release-build',
    );
    expect(
      packageKind({ platform: 'linux', packaged: true, env: {}, hasInstallerIdentity: false }),
    ).toBe('managed');
    expect(
      installDisabledReason({ ...identity, packageKind: 'AppImage' }, 'linux'),
    ).toBeUndefined();
    expect(
      packageKind({
        platform: 'linux',
        packaged: true,
        env: { APPIMAGE: '/downloads/Other.AppImage', APPDIR: '/tmp/other' },
        executablePath: '/opt/yaqmc/yaqmc',
        hasInstallerIdentity: false,
      }),
    ).toBe('managed');
    expect(
      packageKind({
        platform: 'linux',
        packaged: true,
        env: { APPIMAGE: '/downloads/YAQMC.AppImage', APPDIR: '/tmp/yaqmc' },
        executablePath: '/tmp/yaqmc/yaqmc',
        hasInstallerIdentity: false,
      }),
    ).toBe('AppImage');
  });
  it('refuses ambiguous or unhashed assets and binds every content change to a new candidate', () => {
    const value = release('1.1.0');
    const first = releaseCandidate(value, '1.0.0', false, identity)!;
    value.assets[0]!.digest = `sha256:${'b'.repeat(64)}`;
    expect(releaseCandidate(value, '1.0.0', false, identity)?.id).not.toBe(first.id);
    value.assets.push(value.assets[0]!);
    expect(releaseCandidate(value, '1.0.0', false, identity)?.asset).toBeUndefined();
  });
});
