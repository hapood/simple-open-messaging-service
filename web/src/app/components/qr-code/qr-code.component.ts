import { Component, computed, input } from '@angular/core';
import { encode } from 'uqr';

/**
 * Renders a value as a scannable QR code — one crisp SVG `<path>` (a sub-path per dark module) over a white
 * background rect. The matrix comes from `uqr` (tiny, dependency-free, ESM-native); `boostEcc` raises error
 * correction so a partially-obscured code still scans, and `border` bakes in a quiet zone.
 *
 * Dark-on-white is hardcoded via `--qr-fg`/`--qr-bg` (defaulting to black/white) for SCAN RELIABILITY:
 * phone cameras + ML Kit decode dark-on-light most reliably, so the code deliberately does NOT follow the
 * app's dark theme. The host sizes the SVG (width/height 100%); the caller pins an integer-px box + any
 * extra quiet-zone padding. The encoded value is the raw QR token — the phone's scanner hands it straight to
 * `qrScan`, so no URL scheme is involved (consistent with the no-URL-borne-token rule).
 */
@Component({
  selector: 'app-qr-code',
  templateUrl: './qr-code.component.html',
  styleUrl: './qr-code.component.scss',
})
export class QrCodeComponent {
  /** The value to encode (the raw QR token). Empty → nothing rendered. */
  readonly value = input<string>('');
  /** Accessible label for the SVG (the code itself is not meaningful to a screen reader). */
  readonly ariaLabel = input<string>('QR code');

  /** Encode the value once per change → a single SVG path string + the matrix size. */
  readonly qr = computed(() => {
    const v = this.value();
    if (!v) return null;
    const { data, size } = encode(v, { ecc: 'M', boostEcc: true, border: 2 });
    let d = '';
    for (let r = 0; r < size; r++) {
      const row = data[r];
      for (let c = 0; c < size; c++) {
        if (row[c]) d += `M${c} ${r}h1v1h-1z`;
      }
    }
    return { d, size };
  });
}
