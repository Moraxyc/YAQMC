import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import type { AppBuildSource, AppPackageKind, AppUpdateCandidate } from '@yaqmc/client';

const semver = createRequire(import.meta.url)('semver') as {
  valid(value: string): string | null;
  compare(a: string, b: string): number;
  prerelease(value: string): unknown[] | null;
};

export const RELEASES_API = 'https://api.github.com/repos/YAQMC/YAQMC/releases';
export const RELEASES_URL = 'https://github.com/YAQMC/YAQMC/releases';
export type BuildIdentity = {
  source: AppBuildSource;
  commit: string;
  tag: string;
  architecture: string;
  packageKind: AppPackageKind;
};

export function packageKind(facts: {
  platform: string;
  packaged: boolean;
  env: NodeJS.ProcessEnv;
  hasInstallerIdentity: boolean;
  executablePath?: string;
}): AppPackageKind {
  if (!facts.packaged) return 'managed';
  if (facts.platform === 'win32') {
    if (facts.env.PORTABLE_EXECUTABLE_FILE) return 'portable';
    if (facts.hasInstallerIdentity) return 'nsis';
  }
  if (
    facts.platform === 'linux' &&
    facts.env.APPIMAGE &&
    facts.env.APPDIR &&
    facts.executablePath &&
    facts.executablePath.startsWith(`${facts.env.APPDIR.replace(/\/$/u, '')}/`)
  )
    return 'AppImage';
  return 'managed';
}

export function installDisabledReason(
  identity: BuildIdentity,
  platform: string,
): string | undefined {
  if (identity.source !== 'official-release') return 'non-release-build';
  if (!['x64', 'arm64'].includes(identity.architecture)) return 'unsupported-architecture';
  if (identity.packageKind === 'managed') return 'managed-installation';
  if (platform === 'win32' && ['nsis', 'portable'].includes(identity.packageKind)) return;
  if (platform === 'linux' && identity.packageKind === 'AppImage') return;
  return 'unsupported-package';
}

export function compareVersions(a: string, b: string): number | undefined {
  return semver.valid(a) && semver.valid(b) ? semver.compare(a, b) : undefined;
}

export function assetName(identity: BuildIdentity): string | undefined {
  const arch = identity.architecture;
  if (!['x64', 'arm64'].includes(arch)) return;
  if (identity.packageKind === 'nsis') return `YAQMC-windows-${arch}-setup.exe`;
  if (identity.packageKind === 'portable') return `YAQMC-windows-${arch}-portable.exe`;
  if (identity.packageKind === 'AppImage') return `YAQMC-linux-${arch}.AppImage`;
}

export function releaseCandidate(
  input: unknown,
  currentVersion: string,
  includePrerelease: boolean,
  identity: BuildIdentity,
): AppUpdateCandidate | undefined {
  if (!input || typeof input !== 'object') return;
  const r = input as Record<string, unknown>;
  if (r.draft !== false || !Number.isSafeInteger(r.id) || typeof r.tag_name !== 'string') return;
  const version = r.tag_name.replace(/^v/u, '');
  if (
    semver.valid(version) !== version.split('+')[0] ||
    compareVersions(version, currentVersion) !== 1
  )
    return;
  if (!includePrerelease && (r.prerelease === true || semver.prerelease(version))) return;
  const tag = r.tag_name;
  if (tag !== `v${version}`) return;
  const releaseUrl = `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`;
  const name = assetName(identity);
  const assets = Array.isArray(r.assets) ? (r.assets as Record<string, unknown>[]) : [];
  const matching = assets.filter((a) => a && a.name === name);
  const a = matching.length === 1 ? matching[0] : undefined;
  let asset: AppUpdateCandidate['asset'];
  const base = `${RELEASES_URL}/download/${encodeURIComponent(tag)}/`;
  if (
    a &&
    Number.isSafeInteger(a.id) &&
    Number.isSafeInteger(a.size) &&
    Number(a.size) > 0 &&
    typeof a.digest === 'string' &&
    /^sha256:[a-f0-9]{64}$/u.test(a.digest) &&
    a.browser_download_url === `${base}${encodeURIComponent(name!)}`
  ) {
    const metadataName = `updater-windows-${identity.architecture}.yml`;
    const metadata = assets.filter((item) => item.name === metadataName);
    asset = {
      id: Number(a.id),
      name: name!,
      size: Number(a.size),
      sha256: a.digest.slice(7),
      url: String(a.browser_download_url),
      ...(identity.packageKind === 'nsis' &&
      metadata.length === 1 &&
      metadata[0]?.browser_download_url === `${base}${metadataName}`
        ? { metadataUrl: `${base}${metadataName}` }
        : {}),
    };
  }
  const candidate = {
    releaseId: Number(r.id),
    tag,
    version,
    releaseUrl,
    notes: typeof r.body === 'string' ? r.body.slice(0, 125_000) : '',
    ...(asset ? { asset } : {}),
  };
  return { ...candidate, id: createHash('sha256').update(JSON.stringify(candidate)).digest('hex') };
}

export function selectRelease(
  releases: unknown[],
  current: string,
  includePrerelease: boolean,
  identity: BuildIdentity,
): AppUpdateCandidate | undefined {
  return releases
    .map((r) => releaseCandidate(r, current, includePrerelease, identity))
    .filter((r): r is AppUpdateCandidate => !!r)
    .sort((a, b) => compareVersions(b.version, a.version) ?? 0)[0];
}
