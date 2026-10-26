import { describe, expect, it, vi } from 'vitest';
import { createElectronBridge } from './electron';

describe('Electron result envelope', () => {
  it('reconstructs provider error details on the renderer side', async () => {
    const details = {
      code: 'provider-not-configured',
      message: 'Configure Spotify',
      retryable: false,
    };
    const invoke = vi.fn();
    const bridge = createElectronBridge({
      invoke,
      on: () => () => {},
      invokeResult: async () => ({
        ok: false,
        error: { code: 'core.provider', message: 'Configure Spotify', retryable: false, details },
      }),
    });
    await expect(
      bridge.invoke('provider_account_snapshot', { providerId: 'spotify' }),
    ).rejects.toMatchObject({ code: 'core.provider', details });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps older preloads working', async () => {
    const bridge = createElectronBridge({ invoke: async () => [], on: () => () => {} });
    await expect(bridge.invoke('provider_list')).resolves.toEqual([]);
  });
});
