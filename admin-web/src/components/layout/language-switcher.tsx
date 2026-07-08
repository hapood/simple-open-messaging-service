import { useTranslation } from 'react-i18next'
import { Check, Languages } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SUPPORTED_LANGS, type AppLang } from '@/i18n'

// Endonyms: a language is always shown in its own name regardless of the active UI language.
const LANG_LABEL: Record<AppLang, string> = {
  'zh-CN': '中文',
  en: 'English',
}

function normalize(lng: string | undefined): AppLang {
  return lng?.startsWith('zh') ? 'zh-CN' : 'en'
}

export function LanguageSwitcher() {
  const { i18n } = useTranslation()
  const current = normalize(i18n.language)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={buttonVariants({
          variant: 'ghost',
          className: 'w-full justify-start gap-2',
        })}
      >
        <Languages className="size-4" />
        {LANG_LABEL[current]}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {SUPPORTED_LANGS.map((lng) => (
          <DropdownMenuItem key={lng} onClick={() => i18n.changeLanguage(lng)}>
            <span className="flex-1">{LANG_LABEL[lng]}</span>
            {current === lng && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
