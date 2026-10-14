import { enUS } from './en-US';
import { zhCN } from './zh-CN';
import { zhTW } from './zh-TW';

export const defaultLocale = 'en-US' as const;
export const supportedLocales = ['en-US', 'zh-CN', 'zh-TW'] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

export const resources = {
  'en-US': enUS,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
} as const;
