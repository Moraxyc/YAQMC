import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { cargoTargetDir } from './stage-core.mjs';

export function stageUpdateHelper({
  repoRoot,
  env = process.env,
  rustTarget,
  profile = 'release',
}) {
  const name =
    (rustTarget?.includes('windows') ?? process.platform === 'win32')
      ? 'yaqmc-update-helper.exe'
      : 'yaqmc-update-helper';
  const target = cargoTargetDir(env, repoRoot);
  const source = path.join(target, ...(rustTarget ? [rustTarget] : []), profile, name);
  const destination = path.join(repoRoot, 'apps/desktop/resources/updater');
  mkdirSync(destination, { recursive: true });
  const binary = path.join(destination, name);
  copyFileSync(source, binary);
  const sha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
  writeFileSync(
    path.join(destination, 'manifest.json'),
    JSON.stringify({ name, sha256, bytes: statSync(binary).size }),
  );
  return binary;
}
