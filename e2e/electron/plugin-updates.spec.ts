import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { PluginUpdateOperation } from '@yaqmc/client';
import { e2eCoreStatus, e2eQaSandbox, launchElectronNativeWindow } from './launch';

async function invoke<T>(page: Page, method: string, params?: unknown): Promise<T> {
  return page.evaluate(
    async ({ method, params }) => {
      const host = Reflect.get(globalThis, 'yaqmc');
      return host.invoke(method, params);
    },
    { method, params },
  );
}

function fixture(
  root: string,
  id: string,
  version: string,
  revision: string,
  failing = false,
): string {
  const directory = path.join(root, `${id}-${revision}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'manifest.json'),
    JSON.stringify({
      manifestVersion: 1,
      apiVersion: 2,
      id,
      name: id,
      version,
      entrypoints: { script: 'main.js' },
      permissions: ['plugin.storage'],
    }),
  );
  writeFileSync(
    path.join(directory, 'main.js'),
    `definePlugin({ async activate(ctx) {
    const old = await ctx.storage.get('activations');
    await ctx.storage.set('activations', String(Number(old.value || 0) + 1));
    await ctx.storage.set('revision', '${revision}');
    ${failing ? "await ctx.storage.set('session', 'bad-write'); throw new Error('test activation failed');" : ''}
  }});`,
  );
  return directory;
}

async function prepare(page: Page, directory: string): Promise<PluginUpdateOperation> {
  const op = await invoke<PluginUpdateOperation>(page, 'plugin_update_prepare', {
    request: { path: directory, unpacked: true },
  });
  let result = op;
  await expect
    .poll(async () => {
      [result] = await invoke<PluginUpdateOperation[]>(page, 'plugin_update_status', {
        operationId: op.operationId,
      });
      return result.phase;
    })
    .toMatch(/^(prepared|unchanged|failed)$/);
  expect(result.phase, result.error ?? '').not.toBe('failed');
  return result;
}

async function apply(page: Page, op: PluginUpdateOperation): Promise<PluginUpdateOperation> {
  await invoke(page, 'plugin_update_apply', {
    request: {
      operationId: op.operationId,
      confirm: true,
      grant: op.preview?.addedPermissions ?? [],
    },
  });
  let result = op;
  await expect
    .poll(
      async () => {
        [result] = await invoke<PluginUpdateOperation[]>(page, 'plugin_update_status', {
          operationId: op.operationId,
        });
        return result.phase;
      },
      { timeout: 30_000 },
    )
    .toMatch(/^(completed|failed)$/);
  return result;
}

async function storage(
  page: Page,
  pluginId: string,
  key: string,
  value?: string,
): Promise<string | null> {
  const token = await invoke<string>(page, 'plugin_runtime_start', { pluginId });
  try {
    const result = await invoke<{ value?: string }>(page, 'plugin_bridge', {
      request: {
        token,
        method: value === undefined ? 'storage.get' : 'storage.set',
        payload: { key, value },
      },
    });
    return result.value ?? null;
  } finally {
    await invoke(page, 'plugin_runtime_stop', { token });
  }
}

test('native update review, hotfix, script rollback and unaffected worker lifetime', async () => {
  test.setTimeout(120_000);
  const session = await launchElectronNativeWindow({ spawnCore: true });
  try {
    const { app, page } = session;
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect.poll(() => e2eCoreStatus(app)).toBe('ready');
    await invoke(page, 'plugin_set_developer_mode', { enabled: true });
    const root = path.join(e2eQaSandbox().root, 'update-fixtures');
    const target = 'dev.test.update';
    const other = 'dev.test.unaffected';
    const original = fixture(root, target, '1.0.0', 'original');
    for (const directory of [original, fixture(root, other, '1.0.0', 'other')]) {
      const result = await apply(page, await prepare(page, directory));
      expect(result.phase, result.error ?? '').toBe('completed');
    }
    expect(await storage(page, target, 'activations')).toBe('1');
    expect(await storage(page, other, 'activations')).toBe('1');
    await storage(page, target, 'session', 'synthetic-session-reference');
    expect((await prepare(page, original)).phase).toBe('unchanged');
    expect(await storage(page, target, 'activations')).toBe('1');

    const hotfix = await prepare(page, fixture(root, target, '1.0.0', 'hotfix'));
    expect(hotfix.preview?.confirmations).toContain('replacement');
    await page.getByRole('button', { name: 'Open application settings' }).click();
    const card = page
      .locator('li')
      .filter({ has: page.getByRole('button', { name: `Open ${target} details`, exact: true }) });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Update / replace', exact: true }).click();
    const review = page.getByRole('dialog', { name: 'Update / replace', exact: true });
    await expect(review).toBeVisible();
    await expect(review).toContainText('Same-version replacement');
    await expect(review).toContainText('No remote update source configured');
    await expect(
      review.getByRole('button', { name: 'Update later (when idle)', exact: true }),
    ).toBeDisabled();
    await review.getByLabel('I have reviewed these changes and confirm the replacement').check();
    await page.screenshot({ path: 'output/playwright/plugin-update-review.png', fullPage: true });
    await review.getByRole('button', { name: 'Update later (when idle)', exact: true }).click();
    await expect(review.getByRole('status')).toHaveText('Completed');
    expect(await storage(page, target, 'revision')).toBe('hotfix');
    expect(await storage(page, target, 'session')).toBe('synthetic-session-reference');
    expect(await storage(page, target, 'activations')).toBe('2');
    expect(await storage(page, other, 'activations')).toBe('1');
    await review.getByRole('button', { name: 'Close', exact: true }).click();

    const failed = await apply(
      page,
      await prepare(page, fixture(root, target, '2.0.0', 'failed', true)),
    );
    expect(failed.phase).toBe('failed');
    expect(failed.error).toBe('update-renderer-start-failed');
    await expect.poll(() => storage(page, target, 'revision')).toBe('hotfix');
    expect(await storage(page, target, 'session')).toBe('synthetic-session-reference');
    expect(await storage(page, other, 'activations')).toBe('1');
    await invoke(page, 'plugin_set_enabled', {
      request: { id: target, enabled: false, grant: [] },
    });
    const disabledUpdate = await apply(
      page,
      await prepare(page, fixture(root, target, '1.1.0', 'disabled')),
    );
    expect(disabledUpdate.phase, disabledUpdate.error ?? '').toBe('completed');
    const records = await invoke<Array<{ id: string; enabled: boolean; version: string }>>(
      page,
      'plugin_list',
    );
    expect(records.find((p) => p.id === target)).toMatchObject({
      enabled: false,
      version: '1.1.0',
    });
    // The test deliberately issues many storage probes. Let Core's one-second
    // storage budget reset so the injected activation error is the failure.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const disabledFailure = await apply(
      page,
      await prepare(page, fixture(root, target, '2.0.0', 'disabled-failure', true)),
    );
    expect(disabledFailure.error).toBe('update-renderer-start-failed');
    expect(await storage(page, other, 'activations')).toBe('1');
  } finally {
    await session.app.close();
  }
});
