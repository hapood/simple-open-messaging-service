import { afterEach, describe, expect, it } from 'vitest'
import i18n, {
  changeAppLanguage,
  i18nReady,
  LANG_STORAGE_KEY,
} from '@/i18n'

describe('admin i18n', () => {
  afterEach(async () => {
    await changeAppLanguage('en')
    window.localStorage.removeItem(LANG_STORAGE_KEY)
  })

  it('switches translations and persists the selected language', async () => {
    await i18nReady
    await changeAppLanguage('zh-CN')

    expect({
      language: i18n.language,
      resolvedLanguage: i18n.resolvedLanguage,
      languages: i18n.languages,
      translation: i18n.t('language.label'),
    }).toEqual({
      language: 'zh-CN',
      resolvedLanguage: 'zh-CN',
      languages: ['zh-CN', 'en'],
      translation: '语言',
    })
    expect(window.localStorage.getItem(LANG_STORAGE_KEY)).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
  })
})
