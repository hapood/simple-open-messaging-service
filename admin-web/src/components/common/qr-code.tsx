import { useMemo } from 'react'
import { encode } from 'uqr'
import { cn } from '@/lib/utils'

/**
 * Renders a value as a scannable QR code — one crisp SVG `<path>` (a sub-path per dark module) over a
 * white background rect. Backed by `uqr` (tiny, dependency-free, ESM-native — the same renderer the
 * consumer web app uses for QR login). `boostEcc` raises error correction so a partially-obscured code
 * still scans, and `border` bakes in a quiet zone.
 *
 * Dark-on-white is hardcoded for SCAN RELIABILITY: phone cameras + the authenticator ML decoder read
 * dark-on-light most reliably, so the code deliberately does NOT follow the app's dark theme. The host
 * sizes the SVG (w/h 100%); the caller pins an integer-px box.
 */
export function QrCode({
  value,
  className,
  'aria-label': ariaLabel = 'QR code',
}: {
  value: string
  className?: string
  'aria-label'?: string
}) {
  const qr = useMemo(() => {
    if (!value) return null
    return encode(value, { ecc: 'M', boostEcc: true, border: 2 })
  }, [value])

  if (!qr) return null

  // One sub-path per dark module → a single <path> (smaller DOM than N×N <rect>s).
  let d = ''
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.data[y][x]) d += `M${x},${y}h1v1h-1z`
    }
  }

  return (
    <svg
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      className={cn('h-full w-full', className)}
      role="img"
      aria-label={ariaLabel}
      shapeRendering="crispEdges"
    >
      <rect width={qr.size} height={qr.size} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  )
}
