import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** Copy-to-clipboard button with a transient check mark; success/failure surfaces via sonner. The caller
 *  supplies the toast keys so the message matches the secret being copied (a login code vs a password). */
export function CopyButton({
  value,
  copiedKey,
  copyFailedKey,
}: {
  value: string
  copiedKey: string
  copyFailedKey: string
}) {
  const { t } = useTranslation()
  // The keys arrive as runtime strings from the caller; cast past i18next's literal-key augmentation
  // (the callers pass real, existing keys — issueLoginCode.copied / generateInitialPassword.copied).
  const tt = t as (key: string) => string
  const [done, setDone] = useState(false)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(tt(copiedKey))
      setDone(true)
      setTimeout(() => setDone(false), 2000)
    } catch {
      toast.error(tt(copyFailedKey))
    }
  }
  return (
    <Button type="button" variant="outline" size="sm" onClick={onCopy}>
      {done ? <Check className="size-4" /> : <Copy className="size-4" />}
    </Button>
  )
}
