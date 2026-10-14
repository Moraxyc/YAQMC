import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { defaultLocale, resources, supportedLocales, type SupportedLocale } from './locales';

export type LocalePreference = 'system' | SupportedLocale;
export const LOCALE_CACHE_KEY = 'yaqmc.locale';
const LEGACY_LOCALE_CACHE_KEY = 'music-client.locale';

export function matchSupportedLocale(locales: readonly string[]): SupportedLocale {
  for (const candidate of locales) {
    const parts = candidate.replaceAll('_', '-').toLowerCase().split('-');
    const normalized = parts.join('-');
    if (parts[0] === 'zh') {
      if (parts.includes('hant')) return 'zh-TW';
      if (parts.includes('hans')) return 'zh-CN';
      return parts.some((part) => ['tw', 'hk', 'mo'].includes(part)) ? 'zh-TW' : 'zh-CN';
    }
    if (normalized === 'en' || normalized.startsWith('en-')) return 'en-US';
  }
  return defaultLocale;
}

export function resolveLocale(
  preference: LocalePreference,
  systemLocales: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages,
): SupportedLocale {
  return preference === 'system' ? matchSupportedLocale(systemLocales) : preference;
}

function cachedLocalePreference(): LocalePreference {
  if (typeof window === 'undefined') return 'system';
  const saved =
    window.localStorage.getItem(LOCALE_CACHE_KEY) ??
    window.localStorage.getItem(LEGACY_LOCALE_CACHE_KEY);
  return supportedLocales.find((locale) => locale === saved) ?? 'system';
}

const initialLocale = resolveLocale(cachedLocalePreference());

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLocale,
  fallbackLng: defaultLocale,
  supportedLngs: [...Object.keys(resources)],
  defaultNS: 'common',
  fallbackNS: 'common',
  interpolation: { escapeValue: false },
  returnNull: false,
  react: { useSuspense: false },
});

if (typeof document !== 'undefined') document.documentElement.lang = initialLocale;

export default i18n;
