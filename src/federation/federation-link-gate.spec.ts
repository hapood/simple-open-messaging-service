import { describe, it, expect } from 'vitest';
import { FederationService } from './federation.service.js';
import { ContentType } from '../prisma/generated/client.js';

/**
 * Pins the LINK media gate in FederationService. A LINK message's og:image is a CAS shard; the
 * federated receiver must localize it (pull bytes via /get_file). isMediaContentType is the gate — if
 * LINK is ever dropped from it, the receiver silently skips localization and the thumbnail stays a dead
 * cross-origin URL under Tauri's CSP. The full two-process localization flow is covered by the IMAGE
 * e2e (localizeMedia is digest-based, identical for LINK); this locks the type gate itself.
 *
 * Accessed via prototype — isMediaContentType is a pure function of its argument (no `this` use), so no
 * instance construction (FederationService has 11 injected deps) is needed.
 */
describe('FederationService isMediaContentType (LINK gate)', () => {
  const isMediaContentType = (t: ContentType): boolean =>
    (
      FederationService.prototype as unknown as {
        isMediaContentType: (t: ContentType) => boolean;
      }
    ).isMediaContentType(t);

  it('classifies LINK as media so the receiver localizes the og:image thumbnail', () => {
    expect(isMediaContentType(ContentType.LINK)).toBe(true);
  });

  it('still classifies the original media types and excludes text/invite', () => {
    expect(isMediaContentType(ContentType.IMAGE)).toBe(true);
    expect(isMediaContentType(ContentType.FILE)).toBe(true);
    expect(isMediaContentType(ContentType.VIDEO)).toBe(true);
    expect(isMediaContentType(ContentType.AUDIO)).toBe(true);
    expect(isMediaContentType(ContentType.PURE_TEXT)).toBe(false);
    expect(isMediaContentType(ContentType.INVITE)).toBe(false);
  });
});
