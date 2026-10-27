import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function writeAppUpdateMetadata(directory, version, architecture) {
  if (!['x64', 'arm64'].includes(architecture)) throw new Error('invalid updater architecture');
  const name = `YAQMC-windows-${architecture}-setup.exe`;
  const bytes = readFileSync(path.join(directory, name));
  const file = `updater-windows-${architecture}.yml`;
  writeFileSync(
    path.join(directory, file),
    `version: ${JSON.stringify(version)}\nfiles:\n  - url: ${name}\n    sha512: ${createHash('sha512').update(bytes).digest('base64')}\n    size: ${bytes.length}\npath: ${name}\nsha512: ${createHash('sha512').update(bytes).digest('base64')}\n`,
  );
  return file;
}
