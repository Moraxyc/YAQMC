import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { FRAME_HARD_CAP_BYTES, type OAuthPrepareResult } from '@yaqmc/client';
import {
  isOAuthCallbackUrl,
  oauthPartitionName,
  oauthWindowCreateOptions,
  oauthWindowLabel,
  oauthWindowTitle,
  openOAuthWindow,
  openProviderOAuthWindow,
  providerOAuthPartitionName,
  providerOAuthWindowLabel,
  urlMatchesOAuthAllowlist,
  type OAuthNavigationEvent,
  type OAuthWindowCreateOptions,
  type OAuthWindowDeps,
  type OAuthWindowLike,
  type ProviderOAuthWindowDeps,
} from './oauth-window';

const CALLBACK_PREFIX = 'https://y.qq.com/portal/wx_redirect.html';
const AUTH_URL = 'https://graph.qq.com/oauth2.0/show?client_id=1';

type OAuthPolicyFixture = {
  kind: 'allowlist' | 'callback';
  expected: boolean;
  url: string;
  policy: string;
};

const oauthPolicyFixtures = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../packages/yaqmc-client/fixtures/oauth-url-policy.tsv',
  ),
  'utf8',
)
  .trim()
  .split(/\r?\n/u)
  .slice(1)
  .map((line, index): OAuthPolicyFixture => {
    const [kind, expected, url, policy] = line.split('\t');
    if (
      (kind !== 'allowlist' && kind !== 'callback') ||
      (expected !== 'true' && expected !== 'false') ||
      url === undefined ||
      policy === undefined
    ) {
      throw new Error(`Invalid OAuth policy fixture at row ${index + 2}`);
    }
    return { kind, expected: expected === 'true', url, policy };
  });
const PREPARED: OAuthPrepareResult = {
  attemptId: 'attempt-0',
  url: AUTH_URL,
  navigationAllowlist: [
    'https://graph.qq.com/**',
    'https://xui.ptlogin2.qq.com/**',
    `${CALLBACK_PREFIX}**`,
  ],
  callbackMatcher: { urlPrefix: CALLBACK_PREFIX },
};

type MockOAuthWindow = OAuthWindowLike & {
  emitNavigate(url: string): { preventDefault: ReturnType<typeof vi.fn> };
  emitRedirect(url: string): { preventDefault: ReturnType<typeof vi.fn> };
  emitClosed(): void;
};

function mockWindow(): MockOAuthWindow {
  const contentsListeners: Record<
    'will-navigate' | 'will-redirect',
    Array<(event: OAuthNavigationEvent, url: string) => void>
  > = {
    'will-navigate': [],
    'will-redirect': [],
  };
  const closedListeners: Array<() => void> = [];

  const emit = (
    event: 'will-navigate' | 'will-redirect',
    url: string,
  ): { preventDefault: ReturnType<typeof vi.fn> } => {
    const preventDefault = vi.fn();
    for (const listener of contentsListeners[event]) {
      listener({ preventDefault }, url);
    }
    return { preventDefault };
  };

  const window: MockOAuthWindow = {
    webContents: {
      on: vi.fn(
        (
          event: 'will-navigate' | 'will-redirect',
          listener: (navigationEvent: OAuthNavigationEvent, url: string) => void,
        ) => {
          contentsListeners[event].push(listener);
        },
      ),
      setWindowOpenHandler: vi.fn(),
    },
    loadURL: vi.fn(),
    close: vi.fn(() => {
      window.emitClosed();
    }),
    on: vi.fn((event: 'closed', listener: () => void) => {
      if (event === 'closed') {
        closedListeners.push(listener);
      }
    }),
    emitNavigate: (url) => emit('will-navigate', url),
    emitRedirect: (url) => emit('will-redirect', url),
    emitClosed: () => {
      for (const listener of closedListeners.splice(0)) {
        listener();
      }
    },
  };
  return window;
}

function depsFor(
  window: MockOAuthWindow,
  overrides: Partial<OAuthWindowDeps> = {},
): {
  deps: OAuthWindowDeps;
  createWindow: ReturnType<typeof vi.fn>;
  fromPartition: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  options: () => OAuthWindowCreateOptions;
} {
  const session = { partition: 'mock-oauth-session' };
  let captured: OAuthWindowCreateOptions | undefined;
  const createWindow = vi.fn((options: OAuthWindowCreateOptions) => {
    captured = options;
    return window;
  });
  const fromPartition = vi.fn<OAuthWindowDeps['fromPartition']>(() => session);
  const prepare = vi.fn(async () => PREPARED);
  const complete = vi.fn(async () => ({ ok: true }));
  const cancel = vi.fn(async () => ({ ok: true }));
  return {
    createWindow,
    fromPartition,
    prepare,
    complete,
    cancel,
    options: () => {
      if (!captured) {
        throw new Error('createWindow was not called');
      }
      return captured;
    },
    deps: {
      createWindow,
      fromPartition,
      isPackaged: true,
      auth_oauth_prepare: prepare,
      auth_oauth_complete: complete,
      auth_oauth_cancel: cancel,
      ...overrides,
    },
  };
}

function providerDepsFor(window: MockOAuthWindow) {
  const session = { partition: 'mock-provider-oauth-session' };
  let captured: OAuthWindowCreateOptions | undefined;
  const createWindow = vi.fn((options: OAuthWindowCreateOptions) => {
    captured = options;
    return window;
  });
  const fromPartition = vi.fn<ProviderOAuthWindowDeps['fromPartition']>(() => session);
  const prepare = vi.fn(async () => PREPARED);
  const complete = vi.fn(async () => ({ ok: true }));
  const cancel = vi.fn(async () => ({ ok: true }));
  return {
    createWindow,
    fromPartition,
    prepare,
    complete,
    cancel,
    options: () => {
      if (!captured) throw new Error('createWindow was not called');
      return captured;
    },
    deps: {
      createWindow,
      fromPartition,
      isPackaged: true,
      provider_auth_oauth_prepare: prepare,
      provider_auth_oauth_complete: complete,
      provider_auth_oauth_cancel: cancel,
    } satisfies ProviderOAuthWindowDeps,
  };
}

describe('oauth partition and construction', () => {
  it('uses an ephemeral oauth: partition, no preload, and 480×640', async () => {
    const window = mockWindow();
    const harness = depsFor(window);
    await openOAuthWindow('qq', harness.deps);

    expect(harness.prepare).toHaveBeenCalledWith({ providerKind: 'qq' });
    expect(harness.fromPartition).toHaveBeenCalledWith('oauth:attempt-0', { cache: false });
    expect(oauthPartitionName('attempt-0').startsWith('persist:')).toBe(false);
    expect(oauthWindowLabel('attempt-0')).toBe('qqmusic-oauth-attempt-0');

    const options = harness.options();
    expect(options).toMatchObject({
      title: oauthWindowTitle('qq'),
      width: 480,
      height: 640,
      show: true,
    });
    expect(options.webPreferences).toEqual({
      session: { partition: 'mock-oauth-session' },
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: false,
    });
    expect(options.webPreferences).not.toHaveProperty('preload');
    expect(window.loadURL).toHaveBeenCalledWith(AUTH_URL);
    expect(window.webContents.setWindowOpenHandler).toHaveBeenCalledOnce();
  });

  it('disables devtools only when packaged', () => {
    const packaged = oauthWindowCreateOptions({
      title: 't',
      session: {},
      isPackaged: true,
    });
    const unpackaged = oauthWindowCreateOptions({
      title: 't',
      session: {},
      isPackaged: false,
    });
    expect(packaged.webPreferences.devTools).toBe(false);
    expect(unpackaged.webPreferences.devTools).toBe(true);
    expect(packaged.webPreferences).not.toHaveProperty('preload');
  });
});

describe('oauth allowlist globs', () => {
  const allowlist = PREPARED.navigationAllowlist;

  it('allows prepare-host /** globs and denies everything else', () => {
    expect(urlMatchesOAuthAllowlist(AUTH_URL, allowlist)).toBe(true);
    expect(urlMatchesOAuthAllowlist('https://xui.ptlogin2.qq.com/cgi-bin/xlogin', allowlist)).toBe(
      true,
    );
    expect(
      urlMatchesOAuthAllowlist('https://graph.qq.com.evil.example/oauth2.0/show', allowlist),
    ).toBe(false);
    expect(urlMatchesOAuthAllowlist('http://graph.qq.com/oauth2.0/show', allowlist)).toBe(false);
    expect(urlMatchesOAuthAllowlist('https://evil.test/', allowlist)).toBe(false);
    expect(urlMatchesOAuthAllowlist('file:///etc/passwd', allowlist)).toBe(false);
    expect(urlMatchesOAuthAllowlist('javascript:alert(1)', allowlist)).toBe(false);
    expect(urlMatchesOAuthAllowlist(`${CALLBACK_PREFIX}.evil?code=abc`, allowlist)).toBe(false);
  });

  it('matches callback scheme, authority, path, and required query parameters structurally', () => {
    const callback = `${CALLBACK_PREFIX}?code=abc&state=1`;
    expect(isOAuthCallbackUrl(callback, CALLBACK_PREFIX)).toBe(true);
    expect(isOAuthCallbackUrl('https://evil.test/?next=' + CALLBACK_PREFIX, CALLBACK_PREFIX)).toBe(
      false,
    );
    expect(isOAuthCallbackUrl(`${CALLBACK_PREFIX}.evil?code=abc&state=1`, CALLBACK_PREFIX)).toBe(
      false,
    );
    expect(
      isOAuthCallbackUrl(
        'https://y.qq.com/portal/wx_redirect.html/extra?code=abc&state=1',
        CALLBACK_PREFIX,
      ),
    ).toBe(false);
    expect(
      isOAuthCallbackUrl(
        `${CALLBACK_PREFIX}?login_type=1&code=abc&state=1`,
        `${CALLBACK_PREFIX}?login_type=1`,
      ),
    ).toBe(true);
    expect(
      isOAuthCallbackUrl(
        `${CALLBACK_PREFIX}?login_type=2&code=abc&state=1`,
        `${CALLBACK_PREFIX}?login_type=1`,
      ),
    ).toBe(false);
    expect(isOAuthCallbackUrl('not a URL', CALLBACK_PREFIX)).toBe(false);
    expect(isOAuthCallbackUrl(callback, 'not a URL')).toBe(false);
    expect(urlMatchesOAuthAllowlist(callback, allowlist)).toBe(true);

    const spotifyCallback = 'http://127.0.0.1:43821/oauth/spotify/callback';
    expect(isOAuthCallbackUrl(`${spotifyCallback}?code=abc&state=1`, spotifyCallback)).toBe(true);
    expect(
      isOAuthCallbackUrl(
        'http://localhost:43821/oauth/spotify/callback?code=abc&state=1',
        spotifyCallback,
      ),
    ).toBe(false);
    expect(
      isOAuthCallbackUrl(
        'http://127.0.0.1.evil.test:43821/oauth/spotify/callback?code=abc&state=1',
        spotifyCallback,
      ),
    ).toBe(false);
  });
});

describe('shared OAuth URL policy contract', () => {
  for (const fixture of oauthPolicyFixtures) {
    it(`${fixture.kind} ${fixture.expected ? 'allows' : 'rejects'} ${fixture.url}`, () => {
      const actual =
        fixture.kind === 'allowlist'
          ? urlMatchesOAuthAllowlist(fixture.url, fixture.policy.split('|'))
          : isOAuthCallbackUrl(fixture.url, fixture.policy);
      expect(actual).toBe(fixture.expected);
    });
  }
});

describe('provider-scoped oauth lifecycle', () => {
  it('binds the ephemeral partition and Core calls to provider and attempt IDs', async () => {
    const window = mockWindow();
    const harness = providerDepsFor(window);
    const authorization = await openProviderOAuthWindow(
      { providerId: 'plugin.example', methodId: 'browser-oauth' },
      harness.deps,
    );

    expect(harness.prepare).toHaveBeenCalledWith({
      providerId: 'plugin.example',
      methodId: 'browser-oauth',
    });
    expect(harness.fromPartition).toHaveBeenCalledWith('oauth:plugin.example:attempt-0', {
      cache: false,
    });
    expect(providerOAuthPartitionName('plugin.example', 'attempt-0')).not.toMatch(/^persist:/u);
    expect(providerOAuthWindowLabel('plugin.example', 'attempt-0')).toBe(
      'provider-oauth-plugin.example-attempt-0',
    );
    expect(harness.options().webPreferences).not.toHaveProperty('preload');

    const callback = `${CALLBACK_PREFIX}?code=provider-code`;
    window.emitRedirect(callback);
    await vi.waitFor(() =>
      expect(harness.complete).toHaveBeenCalledWith({
        providerId: 'plugin.example',
        attemptId: 'attempt-0',
        callbackUrl: callback,
      }),
    );
    await expect(authorization.completion).resolves.toEqual({ ok: true });
    expect(harness.cancel).not.toHaveBeenCalled();
  });

  it('cancels only the matching provider attempt when the user closes', async () => {
    const window = mockWindow();
    const harness = providerDepsFor(window);
    await openProviderOAuthWindow(
      { providerId: 'plugin.example', methodId: 'browser-oauth' },
      harness.deps,
    );
    window.emitClosed();
    await vi.waitFor(() =>
      expect(harness.cancel).toHaveBeenCalledWith({
        providerId: 'plugin.example',
        attemptId: 'attempt-0',
      }),
    );
    expect(harness.complete).not.toHaveBeenCalled();
  });
});

describe('oauth navigation and lifecycle', () => {
  it('denies navigation off the prepare allowlist', async () => {
    const window = mockWindow();
    const harness = depsFor(window);
    await openOAuthWindow('qq', harness.deps);

    const allowed = window.emitNavigate(AUTH_URL);
    expect(allowed.preventDefault).not.toHaveBeenCalled();

    const denied = window.emitNavigate('https://evil.test/phish');
    expect(denied.preventDefault).toHaveBeenCalledOnce();
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.cancel).not.toHaveBeenCalled();
  });

  it('captures will-navigate and will-redirect callback URLs via auth_oauth_complete', async () => {
    const window = mockWindow();
    const harness = depsFor(window);
    await openOAuthWindow('wechat', harness.deps);
    expect(harness.prepare).toHaveBeenCalledWith({ providerKind: 'wechat' });

    const callback = `${CALLBACK_PREFIX}?code=from-navigate`;
    const blocked = window.emitNavigate(callback);
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(harness.complete).toHaveBeenCalledWith({
        attemptId: 'attempt-0',
        callbackUrl: callback,
      });
    });
    expect(window.close).toHaveBeenCalledOnce();
    expect(harness.cancel).not.toHaveBeenCalled();
  });

  it('captures a will-redirect callback without a second complete', async () => {
    const window = mockWindow();
    const harness = depsFor(window);
    await openOAuthWindow('qq', harness.deps);

    const callback = `${CALLBACK_PREFIX}?code=from-redirect`;
    window.emitRedirect(callback);
    await vi.waitFor(() => {
      expect(harness.complete).toHaveBeenCalledTimes(1);
    });
    window.emitNavigate(callback);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.cancel).not.toHaveBeenCalled();
  });

  it('calls auth_oauth_cancel when the user closes the window', async () => {
    const window = mockWindow();
    const harness = depsFor(window);
    await openOAuthWindow('qq', harness.deps);

    window.emitClosed();
    await vi.waitFor(() => {
      expect(harness.cancel).toHaveBeenCalledWith({ attemptId: 'attempt-0' });
    });
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it('cancels and rejects completion when the initial page load fails', async () => {
    const window = mockWindow();
    const loadError = new Error('oauth page failed to load');
    window.loadURL = vi.fn(() => Promise.reject(loadError));
    const harness = depsFor(window);
    const authorization = await openOAuthWindow('qq', harness.deps);

    await expect(authorization.completion).rejects.toBe(loadError);
    await vi.waitFor(() => expect(harness.cancel).toHaveBeenCalledOnce());
    expect(window.close).toHaveBeenCalledOnce();
    window.emitClosed();
    expect(harness.cancel).toHaveBeenCalledOnce();
  });

  it('does not cancel after a callback capture even if closed fires', async () => {
    const window = mockWindow();
    let finishComplete: (() => void) | undefined;
    const complete = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          finishComplete = () => resolve({ ok: true });
        }),
    );
    const harness = depsFor(window, { auth_oauth_complete: complete });
    await openOAuthWindow('qq', harness.deps);

    window.emitNavigate(`${CALLBACK_PREFIX}?code=pending`);
    expect(complete).toHaveBeenCalledOnce();
    window.emitClosed();
    expect(harness.cancel).not.toHaveBeenCalled();
    finishComplete?.();
    await vi.waitFor(() => {
      expect(window.close).toHaveBeenCalledOnce();
    });
    expect(harness.cancel).not.toHaveBeenCalled();
  });

  it('cancels and rejects provider completion when the initial page load fails', async () => {
    const window = mockWindow();
    const loadError = new Error('provider oauth page failed to load');
    window.loadURL = vi.fn(() => Promise.reject(loadError));
    const harness = providerDepsFor(window);
    const authorization = await openProviderOAuthWindow(
      { providerId: 'plugin.example', methodId: 'browser-oauth' },
      harness.deps,
    );

    await expect(authorization.completion).rejects.toBe(loadError);
    await vi.waitFor(() =>
      expect(harness.cancel).toHaveBeenCalledWith({
        providerId: 'plugin.example',
        attemptId: 'attempt-0',
      }),
    );
    expect(harness.cancel).toHaveBeenCalledOnce();
    expect(window.close).toHaveBeenCalledOnce();
    window.emitClosed();
    expect(harness.cancel).toHaveBeenCalledOnce();
  });

  it('allows Spotify login redirects and captures only the exact loopback callback', async () => {
    const window = mockWindow();
    const harness = providerDepsFor(window);
    const callback = 'http://127.0.0.1:43821/oauth/spotify/callback';
    harness.prepare.mockResolvedValue({
      attemptId: 'spotify-attempt',
      url: 'https://accounts.spotify.com/authorize?state=fixture',
      navigationAllowlist: ['https://accounts.spotify.com/**'],
      callbackMatcher: { urlPrefix: callback },
    });
    const authorization = await openProviderOAuthWindow(
      { providerId: 'org.yaqmc.providers.music.spotify', methodId: 'browser-oauth' },
      harness.deps,
    );
    expect(
      window.emitRedirect('https://accounts.spotify.com/en/login?continue=authorize')
        .preventDefault,
    ).not.toHaveBeenCalled();
    expect(
      window.emitNavigate('https://accounts.spotify.com.evil.test/login').preventDefault,
    ).toHaveBeenCalledOnce();
    expect(
      window.emitRedirect(`${callback}/extra?state=fixture&code=test`).preventDefault,
    ).toHaveBeenCalledOnce();
    expect(harness.complete).not.toHaveBeenCalled();
    const callbackUrl = `${callback}?state=fixture&code=test`;
    expect(window.emitRedirect(callbackUrl).preventDefault).toHaveBeenCalledOnce();
    await expect(authorization.completion).resolves.toEqual({ ok: true });
    expect(harness.complete).toHaveBeenCalledWith({
      providerId: 'org.yaqmc.providers.music.spotify',
      attemptId: 'spotify-attempt',
      callbackUrl,
    });
    expect(harness.cancel).not.toHaveBeenCalled();
  });

  it('cancels the attempt when window construction fails', async () => {
    const window = mockWindow();
    const harness = depsFor(window, {
      createWindow: () => {
        throw new Error('no display');
      },
    });
    await expect(openOAuthWindow('qq', harness.deps)).rejects.toThrow('no display');
    expect(harness.cancel).toHaveBeenCalledWith({ attemptId: 'attempt-0' });
    expect(harness.complete).not.toHaveBeenCalled();
  });
});

describe('provider browser session login', () => {
  function browserHarness() {
    const window = mockWindow();
    const harness = providerDepsFor(window);
    const listeners = new Set<() => void>();
    let values: Array<{ name: string; value: string }> = [];
    const cookies = {
      get: vi.fn(async (_filter: { url: string }) => values),
      on: vi.fn((_event: string, listener: () => void) => {
        listeners.add(listener);
      }),
      removeListener: vi.fn((_event: string, listener: () => void) => {
        listeners.delete(listener);
      }),
    };
    const session = { cookies, clearStorageData: vi.fn(async () => undefined) };
    harness.fromPartition.mockReturnValue(session);
    harness.prepare.mockResolvedValue({
      attemptId: 'browser-attempt',
      url: 'https://music.163.com/api/sns/authorize?snsType=5',
      navigationAllowlist: ['https://music.163.com/**', 'https://graph.qq.com/**'],
      callbackMatcher: { urlPrefix: 'https://music.163.com/back/qq' },
      browserSession: {
        url: 'https://music.163.com/',
        cookieNames: ['MUSIC_U', '__csrf'],
        requiredCookieNames: ['MUSIC_U'],
        credentialOrigins: ['https://interfacepc.music.163.com'],
        format: 'cookie',
      },
    });
    return {
      ...harness,
      window,
      cookies,
      session,
      changed(next: typeof values) {
        values = next;
        for (const listener of listeners) listener();
      },
    };
  }

  it('lets the official callback run and transfers only named music cookies once', async () => {
    const harness = browserHarness();
    const authorization = await openProviderOAuthWindow(
      { providerId: 'music.netease', methodId: 'qq' },
      harness.deps,
    );
    expect(
      harness.window.emitRedirect('https://music.163.com/back/qq?code=fixture&state=official')
        .preventDefault,
    ).not.toHaveBeenCalled();
    harness.changed([{ name: '__csrf', value: 'fixture' }]);
    await vi.waitFor(() =>
      expect(harness.cookies.get).toHaveBeenCalledWith({ url: 'https://music.163.com/' }),
    );
    expect(harness.complete).not.toHaveBeenCalled();
    harness.changed([
      { name: 'MUSIC_U', value: 'synthetic' },
      { name: 'unrelated', value: 'excluded' },
    ]);
    await expect(authorization.completion).resolves.toEqual({ ok: true });
    expect(harness.complete).toHaveBeenCalledExactlyOnceWith({
      providerId: 'music.netease',
      attemptId: 'browser-attempt',
      callbackUrl: 'https://music.163.com/',
      browserSessionCookies: [{ name: 'MUSIC_U', value: 'synthetic' }],
    });
    expect(harness.cancel).not.toHaveBeenCalled();
    expect(harness.session.clearStorageData).toHaveBeenCalledOnce();
    expect(harness.cookies.removeListener).toHaveBeenCalledOnce();
    harness.changed([{ name: 'MUSIC_U', value: 'synthetic' }]);
    expect(harness.complete).toHaveBeenCalledOnce();
  });

  it('cancels when the user closes without a music session cookie', async () => {
    const harness = browserHarness();
    const authorization = await openProviderOAuthWindow(
      { providerId: 'music.netease', methodId: 'wechat' },
      harness.deps,
    );
    harness.window.emitClosed();
    await expect(authorization.completion).resolves.toEqual({ ok: true });
    expect(harness.cancel).toHaveBeenCalledExactlyOnceWith({
      providerId: 'music.netease',
      attemptId: 'browser-attempt',
    });
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.session.clearStorageData).toHaveBeenCalledOnce();
  });

  it('upgrades allowlisted KuGou redirects to HTTPS and blocks unlisted origins', async () => {
    const harness = browserHarness();
    const prepared = await harness.prepare();
    harness.prepare.mockResolvedValue({
      ...prepared,
      url: 'https://openplat-user.kugou.com/qq/?appid=1014',
      navigationAllowlist: [
        'https://openplat-user.kugou.com/**',
        'https://cross.kugou.com/**',
        'https://graph.qq.com/**',
      ],
      callbackMatcher: { urlPrefix: 'https://openplat-user.kugou.com/qq_callback' },
      browserSession: {
        ...prepared.browserSession!,
        url: 'https://openplat-user.kugou.com/',
        cookieNames: ['KuGoo'],
        requiredCookieNames: ['KuGoo'],
        format: 'kugou-web',
      },
    });
    const authorization = await openProviderOAuthWindow(
      { providerId: 'music.kugou', methodId: 'qq' },
      harness.deps,
    );
    const url = 'http://openplat-user.kugou.com/qq_callback?code=fixture';
    expect(harness.window.emitRedirect(url).preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(harness.window.loadURL).toHaveBeenLastCalledWith(url.replace('http:', 'https:')),
    );
    const handoff = 'http://cross.kugou.com/callmsg/?data=synthetic';
    expect(harness.window.emitRedirect(handoff).preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(harness.window.loadURL).toHaveBeenLastCalledWith(handoff.replace('http:', 'https:')),
    );
    const count = vi.mocked(harness.window.loadURL).mock.calls.length;
    expect(
      harness.window.emitRedirect('http://cross.kugou.com.evil.test/callmsg/?data=synthetic')
        .preventDefault,
    ).toHaveBeenCalledOnce();
    expect(harness.window.loadURL).toHaveBeenCalledTimes(count);
    harness.window.emitClosed();
    await authorization.completion;
  });

  it.each(['http:', 'https:'])(
    'reports KuGou mobile-login rejection over %s instead of a blank page',
    async (protocol) => {
      const harness = browserHarness();
      const prepared = await harness.prepare();
      harness.prepare.mockResolvedValue({
        ...prepared,
        url: 'https://openplat-user.kugou.com/qq/?appid=1014',
        navigationAllowlist: ['https://openplat-user.kugou.com/**', 'https://cross.kugou.com/**'],
        callbackMatcher: { urlPrefix: 'https://openplat-user.kugou.com/qq_callback' },
        browserSession: {
          ...prepared.browserSession!,
          url: 'https://openplat-user.kugou.com/',
          cookieNames: ['KuGoo'],
          requiredCookieNames: ['KuGoo'],
          format: 'kugou-web',
        },
      });
      const authorization = await openProviderOAuthWindow(
        { providerId: 'music.kugou', methodId: 'qq' },
        harness.deps,
      );
      expect(
        harness.window.emitRedirect(
          `${protocol}//cross.kugou.com/callmsg/?errcode=20002&msg=untrusted`,
        ).preventDefault,
      ).toHaveBeenCalledOnce();
      await expect(authorization.completion).rejects.toThrow(
        '酷狗要求使用酷狗 App 扫码登录（20002）',
      );
      expect(harness.complete).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(harness.cancel).toHaveBeenCalledOnce());
      expect(harness.session.clearStorageData).toHaveBeenCalledOnce();
      expect(harness.window.close).toHaveBeenCalledOnce();
    },
  );

  it('keeps the HTTPS replacement alive when the cancelled original load rejects', async () => {
    const harness = browserHarness();
    let rejectInitial!: (error: unknown) => void;
    vi.mocked(harness.window.loadURL).mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectInitial = reject;
        }),
    );
    const authorization = await openProviderOAuthWindow(
      { providerId: 'music.netease', methodId: 'qq' },
      harness.deps,
    );
    harness.window.emitRedirect('http://music.163.com/back/qq?code=fixture');
    rejectInitial(Object.assign(new Error('cancelled original navigation'), { errno: -2 }));
    await vi.waitFor(() =>
      expect(harness.window.loadURL).toHaveBeenLastCalledWith(
        'https://music.163.com/back/qq?code=fixture',
      ),
    );
    expect(harness.cancel).not.toHaveBeenCalled();
    harness.changed([{ name: 'MUSIC_U', value: 'synthetic' }]);
    await expect(authorization.completion).resolves.toEqual({ ok: true });
    expect(harness.complete).toHaveBeenCalledOnce();
  });

  it('still reports a failed HTTPS replacement and cancels the attempt', async () => {
    const harness = browserHarness();
    const failure = Object.assign(new Error('replacement failed'), { errno: -2 });
    vi.mocked(harness.window.loadURL)
      .mockImplementationOnce(() => new Promise<void>(() => undefined))
      .mockRejectedValueOnce(failure);
    const authorization = await openProviderOAuthWindow(
      { providerId: 'music.netease', methodId: 'qq' },
      harness.deps,
    );
    harness.window.emitRedirect('http://music.163.com/back/qq?code=fixture');
    await expect(authorization.completion).rejects.toBe(failure);
    expect(harness.cancel).toHaveBeenCalledOnce();
  });

  it('rejects cookie-store failures and clears the temporary session', async () => {
    const harness = browserHarness();
    const authorization = await openProviderOAuthWindow(
      { providerId: 'music.netease', methodId: 'qq' },
      harness.deps,
    );
    harness.cookies.get.mockRejectedValue(new Error('cookie store unavailable'));
    harness.changed([]);
    await expect(authorization.completion).rejects.toThrow('cookie store unavailable');
    expect(harness.cancel).toHaveBeenCalledOnce();
    expect(harness.session.clearStorageData).toHaveBeenCalledOnce();
  });
});

describe('wired status', () => {
  it('is not auto-opened from Main index.ts', () => {
    const index = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.ts'),
      'utf8',
    );
    expect(index).toContain('session.fromPartition');
    expect(index).toContain('createOAuthBrowserWindow');
    expect(index).not.toContain('openOAuthWindow');
  });

  it('does not attach a preload or scrape console-message', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./oauth-window.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('No preload');
    expect(source).not.toContain('preload:');
    expect(source).not.toContain('console-message');
  });
});

describe('protocol cap', () => {
  it('leaves the 32 MiB hard cap unchanged', () => {
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
