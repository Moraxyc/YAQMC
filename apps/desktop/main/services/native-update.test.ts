import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { nativeUpdateResult, recoverNativeUpdate } from './native-update';

const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: processMock.spawn }));

beforeEach(() => {
  processMock.spawn.mockReset();
  processMock.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
});

async function interrupted(state: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'yaqmc-native-recovery-'));
  const operationId = 'a'.repeat(32);
  const target = path.join(root, 'Custom YAQMC.exe');
  const helper = path.join(root, 'updater-helper.exe');
  const directory = path.join(root, 'operations', operationId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(root, 'last-operation.json'), JSON.stringify({ operationId }));
  await writeFile(
    path.join(directory, 'transaction.json'),
    JSON.stringify({ operationId, target, state }),
  );
  return { root, target, helper, directory };
}

it('resumes cleanup after a committed update was interrupted without changing the successful result', async () => {
  const f = await interrupted('completed');
  await recoverNativeUpdate(f.root, f.helper, f.target);
  expect(processMock.spawn).toHaveBeenCalledWith(
    f.helper,
    ['--recover', f.directory],
    expect.objectContaining({ detached: true, windowsHide: true }),
  );
  expect(await nativeUpdateResult(f.root)).toEqual({ state: 'completed', error: undefined });
});

it.each(['rolled-back', 'error'])('does not restart a terminal %s operation', async (state) => {
  const f = await interrupted(state);
  await recoverNativeUpdate(f.root, f.helper, f.target);
  expect(processMock.spawn).not.toHaveBeenCalled();
  expect((await nativeUpdateResult(f.root))?.state).toBe(state);
});

it('does not recover a transaction belonging to another installation path', async () => {
  const f = await interrupted('restarting');
  await recoverNativeUpdate(f.root, f.helper, path.join(f.root, 'Different YAQMC.exe'));
  expect(processMock.spawn).not.toHaveBeenCalled();
});
