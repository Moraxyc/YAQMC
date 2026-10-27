import { expect, test, type Page } from '@playwright/test';
import type { UpdatePayload } from '@yaqmc/client';
import { e2eCoreStatus, launchElectronNativeWindow } from './launch';

async function invoke<T>(page: Page, method: string, params?: unknown): Promise<T> {
  return page.evaluate(
    async ({ method, params }) => Reflect.get(globalThis, 'yaqmc').invoke(method, params),
    { method, params },
  );
}
test('application update settings persist prerelease policy and keep local builds notify-only', async () => {
  test.setTimeout(90_000);
  let session = await launchElectronNativeWindow({ spawnCore: true });
  try {
    await expect(session.page.locator('.app-shell')).toBeVisible();
    await expect.poll(() => e2eCoreStatus(session.app)).toBe('ready');
    await session.page.getByRole('button', { name: 'Open application settings' }).click();
    const updates = session.page
      .locator('section.settings-section')
      .filter({ has: session.page.getByRole('heading', { name: 'Updates', exact: true }) });
    await expect(updates.getByText('Current version: 0.1.1')).toBeVisible();
    const status = await invoke<UpdatePayload>(session.page, 'host_updater_status');
    expect(status.buildSource).toBe('source');
    expect(status.canInstall).toBe(false);
    await expect(updates.getByRole('button', { name: 'Download, update and restart' })).toHaveCount(
      0,
    );
    await updates.getByRole('checkbox', { name: 'Receive prereleases' }).check();
    await expect
      .poll(
        async () =>
          (await invoke<UpdatePayload>(session.page, 'host_updater_status')).allowPrerelease,
      )
      .toBe(true);
    await invoke(session.page, 'host_updater_cancel');
    await session.app.close();
    session = await launchElectronNativeWindow({ spawnCore: true });
    await expect(session.page.locator('.app-shell')).toBeVisible();
    await expect.poll(() => e2eCoreStatus(session.app)).toBe('ready');
    await session.page.getByRole('button', { name: 'Open application settings' }).click();
    await expect(session.page.getByRole('checkbox', { name: 'Receive prereleases' })).toBeChecked();
    await session.page
      .locator('section.settings-section')
      .filter({ has: session.page.getByRole('heading', { name: 'Updates', exact: true }) })
      .screenshot({
        path: 'output/playwright/app-update-settings.png',
      });
    await session.page.getByRole('checkbox', { name: 'Receive prereleases' }).uncheck();
    await invoke(session.page, 'host_updater_cancel');
  } finally {
    await session.app.close();
  }
});
