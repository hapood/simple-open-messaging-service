import 'dayjs/locale/zh-cn'
import dayjs from 'dayjs'
import i18next from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'
import en from '@/locales/en/translation.json'
import zhCN from '@/locales/zh-CN/translation.json'

export const SUPPORTED_LANGS = ['zh-CN', 'en'] as const
export type AppLang = (typeof SUPPORTED_LANGS)[number]
// Default to English when the system language matches no shipped language — mirrors
// the web/Angular end (zh* → zh-CN, en* → en, anything else → en).
export const FALLBACK_LANG: AppLang = 'en'

// localStorage key is prefixed with `admin_` to stay isolated from the C-end app
// on the same origin (mirrors the `admin_refresh_token` convention).
export const LANG_STORAGE_KEY = 'admin_lang'

const resources = {
  'zh-CN': { translation: zhCN },
  en: { translation: en },
} as const

// Bind dayjs locale to the active language so timestamps render with the right
// calendar/locale rules whenever the user switches languages.
function applyDayjsLocale(lng: string): void {
  dayjs.locale(lng === 'zh-CN' ? 'zh-cn' : 'en')
}

function normalizeLanguage(lng: string | undefined): AppLang {
  return lng?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

function applyDocumentLanguage(lng: string): void {
  document.documentElement.lang = normalizeLanguage(lng)
}

export const i18nReady = i18next
  .use(initReactI18next)
  .use(LanguageDetector)
  .init({
    resources,
    fallbackLng: FALLBACK_LANG,
    supportedLngs: [...SUPPORTED_LANGS],
    interpolation: { escapeValue: false }, // React already escapes by default
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANG_STORAGE_KEY,
      caches: ['localStorage'],
      // Treat every Chinese variant (zh-TW/zh-HK/…) as zh-CN, matching the web end's
      // `startsWith('zh')` rule; other unmatched system languages fall back to English.
      convertDetectedLanguage: (lng: string) =>
        lng.toLowerCase().startsWith('zh') ? 'zh-CN' : lng,
    },
  })

i18next.on('languageChanged', (lng) => {
  applyDayjsLocale(lng)
  applyDocumentLanguage(lng)
})

void i18nReady.then(() => {
  applyDayjsLocale(i18next.language || FALLBACK_LANG)
  applyDocumentLanguage(i18next.language || FALLBACK_LANG)
})

/** Change and persist the UI language through one deterministic entry point. */
export async function changeAppLanguage(lng: AppLang): Promise<void> {
  await i18nReady
  await i18next.changeLanguage(lng)
  localStorage.setItem(LANG_STORAGE_KEY, lng)
}

export default i18next

// Type-safe t(): key autocompletion + missing-key checks against the resource shape.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: (typeof resources)['zh-CN']
  }
}
