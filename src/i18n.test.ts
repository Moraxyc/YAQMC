import { afterEach, describe, expect, it } from 'vitest';
import i18n, { matchSupportedLocale, resolveLocale } from './i18n';
import { resources } from './locales';

function keys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  );
}

afterEach(async () => {
  await i18n.changeLanguage('en-US');
});

describe('internationalization', () => {
  it('resolves explicit and system locales with an English fallback', () => {
    expect(matchSupportedLocale(['zh-SG', 'en-US'])).toBe('zh-CN');
    expect(matchSupportedLocale(['fr-FR'])).toBe('en-US');
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN');
    expect(resolveLocale('system', ['en-GB'])).toBe('en-US');
  });

  it('keeps major translation resources structurally complete', () => {
    for (const locale of ['zh-CN', 'zh-TW'] as const) {
      expect(keys(resources[locale])).toEqual(keys(resources['en-US']));
    }
  });

  it.each(['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-CN', 'zh_Hant_HK'])(
    'resolves %s as Traditional Chinese',
    (locale) => {
      expect(matchSupportedLocale([locale, 'en-US'])).toBe('zh-TW');
    },
  );

  it('honors explicit scripts, preferences, and immediate Traditional Chinese switching', async () => {
    expect(matchSupportedLocale(['zh-Hans-TW'])).toBe('zh-CN');
    expect(resolveLocale('zh-TW', ['en-US'])).toBe('zh-TW');
    await i18n.changeLanguage('zh-TW');
    expect(i18n.t('navigation:home')).toBe('首頁');
    expect(i18n.t('navigation:settings')).toBe('設定');
    expect(i18n.t('settings:general.localeChinese')).toBe('简体中文');
    expect(i18n.t('settings:general.localeTraditionalChinese')).toBe('繁體中文');
  });

  it('switches language immediately and falls back for unsupported locales', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(i18n.t('navigation:home')).toBe('首页');
    await i18n.changeLanguage('fr-FR');
    expect(i18n.t('navigation:home')).toBe('Home');
  });
});
