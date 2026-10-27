import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export function readUpdatePreferences(file: string): { includePrerelease: boolean } {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as { includePrerelease?: unknown };
    return { includePrerelease: value.includePrerelease === true };
  } catch {
    return { includePrerelease: false };
  }
}

export function writeUpdatePreferences(file: string, value: { includePrerelease: boolean }) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const next = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(next, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    renameSync(next, file);
  } finally {
    rmSync(next, { force: true });
  }
}
