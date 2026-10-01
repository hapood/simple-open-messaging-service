import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { Public } from '../common/public.decorator.js';
import { FEDERATION_API_PREFIX } from './federation-protocol.js';
import { KeypairService } from './keypair.service.js';
import { S2sSignatureGuard } from './s2s-signature.guard.js';
import { openSealedBox } from './sealed-box.js';

const BASE64_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const BASE64_BOX_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_PLAINTEXT_BYTES = 4096;
const MAX_BOX_CHARS = 8192;

/**
 * POST /s2s/v1/verify — the stateless sealed-challenge oracle (Peer
 * Recognition 12). Recognized peers prove the responder's continued
 * possession of any retained key — current or retired — by having a sealed
 * box opened. Namespace-id to bindings resolution lives on
 * GET /s2s/v1/profile-namespaces/:nsid.
 *
 * The oracle is stateless by design: replay protection is the caller's fresh
 * challenge, not server memory. The recovered plaintext is returned exactly as
 * recovered — the responder MUST NOT interpret, validate, or reject it by
 * content — and callers are expected to compare-and-discard, never store.
 */
@Public()
@Controller(FEDERATION_API_PREFIX)
@UseGuards(S2sSignatureGuard)
export class S2sVerifyController {
  constructor(private readonly keypair: KeypairService) {}

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verify(@Body() body: unknown): Promise<{ value: string }> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw this.malformed('verify body must be a JSON object');
    }
    const record = body as Record<string, unknown>;
    if (
      !('publicKey' in record) ||
      !('encryptedValue' in record) ||
      Object.keys(record).length !== 2
    ) {
      throw this.malformed('verify body must be exactly a sealed challenge');
    }
    return this.openChallenge(record.publicKey, record.encryptedValue);
  }

  private async openChallenge(
    publicKey: unknown,
    encryptedValue: unknown,
  ): Promise<{ value: string }> {
    if (
      typeof publicKey !== 'string' ||
      !BASE64_KEY_RE.test(publicKey) ||
      typeof encryptedValue !== 'string' ||
      !BASE64_BOX_RE.test(encryptedValue) ||
      encryptedValue.length < 48 ||
      encryptedValue.length > MAX_BOX_CHARS
    ) {
      throw this.malformed('malformed sealed challenge');
    }
    const privateKey = this.keypair.getRetainedPrivateKey(publicKey);
    if (!privateKey) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PUBLIC_KEY_UNRECOGNIZED,
        "the supplied public key is not part of this server's retained key history",
        HttpStatus.BAD_REQUEST,
      );
    }
    let sealed: Uint8Array;
    try {
      sealed = Uint8Array.from(Buffer.from(encryptedValue, 'base64'));
    } catch {
      throw this.malformed('malformed sealed challenge');
    }
    const opened = openSealedBox(sealed, privateKey);
    if (!opened || opened.length > MAX_PLAINTEXT_BYTES) {
      throw this.malformed(
        'the sealed challenge does not open under the supplied key',
      );
    }
    return { value: Buffer.from(opened).toString('utf8') };
  }

  private malformed(message: string): BusinessException {
    return new BusinessException(
      BusinessCode.FEDERATION_MALFORMED,
      message,
      HttpStatus.BAD_REQUEST,
    );
  }
}
