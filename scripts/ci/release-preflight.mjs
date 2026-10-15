import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAndroidReleaseTag, rootVersion } from './android-version.mjs';

// Android publication is paused for 0.1.1 while its update support is unfinished.
export function androidReleasePolicy(version) {
  return {
    enabled: version !== '0.1.1',
    reason: version === '0.1.1' ? 'Android 更新尚未完善，本次暂不发布 Android 版。' : null,
  };
}

export function releasePreflight(environment, version) {
  const targets = environment.YAQMC_TARGETS || 'all';
  if (!['all', 'windows', 'linux'].includes(targets)) {
    throw new Error('Invalid release targets');
  }
  const tagged = environment.GITHUB_REF_TYPE === 'tag';
  if (tagged) {
    assertAndroidReleaseTag(version, environment.GITHUB_REF_NAME);
    if (targets !== 'all') throw new Error('Tagged releases require every platform');
  }
  const includeAndroid = androidReleasePolicy(version).enabled;
  const result = { targets, version, tagged, includeAndroid };
  if (!includeAndroid) return result;
  const required = [
    'ANDROID_RELEASE_KEYSTORE_BASE64',
    'ANDROID_RELEASE_KEY_ALIAS',
    'ANDROID_RELEASE_STORE_PASSWORD',
    'ANDROID_RELEASE_KEY_PASSWORD',
    'ANDROID_RELEASE_CERT_SHA256',
  ];
  const missing = required.filter((name) => !environment[name]?.trim());
  if (missing.length) {
    throw new Error(`Missing release-signing secrets: ${missing.join(', ')}`);
  }
  const digest = environment.ANDROID_RELEASE_CERT_SHA256.replace(/[:\s]/gu, '');
  if (!/^[0-9a-f]{64}$/iu.test(digest)) {
    throw new Error('ANDROID_RELEASE_CERT_SHA256 must be a SHA-256 certificate fingerprint');
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = releasePreflight(process.env, rootVersion().versionName);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `include_android=${result.includeAndroid}\n`);
    }
    process.stdout.write(`Release configuration ready: ${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
