import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  isValidGroupAccount,
  isValidSomfpUserAccount,
} from '../common/account.js';
import { ContentType } from '../database/enums.js';
import { UploadService } from '../upload/upload.service.js';
import { canonicalJson } from './canonical-json.js';
import { federatedContentDigests } from './federated-message-content.js';
import type { FederationMessageFeedMessage } from './federation-message-feed.service.js';
import { isFederationQuoteTarget } from './federation-quote-target.js';

/** Validates the closed wire shape and CAS descriptor manifest of an inbound message item. */
@Injectable()
export class FederationInboundMessageValidatorService {
  /** Fingerprint every immutable wire field at a direct-origin coordinate. The parsed content
   * object is canonicalized with the outer envelope so insignificant JSON member order cannot
   * turn an idempotent replay into a conflict. */
  immutableEnvelopeDigest(item: FederationMessageFeedMessage): string {
    return createHash('sha256')
      .update(
        canonicalJson({
          ...item,
          content: JSON.parse(item.content) as unknown,
        }),
        'utf8',
      )
      .digest('hex');
  }

  assertAssetDescriptors(item: FederationMessageFeedMessage): void {
    const expected = new Set(
      federatedContentDigests(item.contentType as ContentType, item.content),
    );
    const described = new Set<string>();
    for (const asset of item.assets) {
      if (
        !/^[a-f0-9]{64}$/.test(asset.digest) ||
        !Number.isSafeInteger(asset.bytes) ||
        asset.bytes < 0
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'invalid missed asset descriptor',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (described.has(asset.digest)) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'invalid or duplicate missed asset descriptor',
          HttpStatus.BAD_REQUEST,
        );
      }
      described.add(asset.digest);
    }
    if (item.contentType === ContentType.CONTACT_CARD) {
      const avatar = item.assets[0];
      if (
        avatar &&
        (avatar.bytes < 1 || avatar.bytes > UploadService.MAX_AVATAR_WIRE_BYTES)
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'contact-card avatar exceeds the profile avatar size limit',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    if (
      expected.size !== described.size ||
      [...expected].some((digest) => !described.has(digest))
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missed asset descriptors do not match message content',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  assertEnvelope(item: FederationMessageFeedMessage): void {
    const assertFields = (
      value: unknown,
      required: string[],
      optional: string[] = [],
    ): Record<string, unknown> => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'federated message contains a non-object descriptor',
          HttpStatus.BAD_REQUEST,
        );
      }
      const record = value as Record<string, unknown>;
      const allowed = new Set([...required, ...optional]);
      if (
        required.some((field) => !(field in record)) ||
        Object.keys(record).some((field) => !allowed.has(field))
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'federated message contains invalid fields',
          HttpStatus.BAD_REQUEST,
        );
      }
      return record;
    };
    const rawThread = item.thread as unknown as Record<string, unknown>;
    const isGroup =
      typeof rawThread?.['account'] === 'string' &&
      rawThread['account'].startsWith('!');
    assertFields(
      item,
      [
        'thread',
        'author',
        'seq',
        'profileRev',
        'originSeq',
        'contentType',
        'content',
        'createdAt',
        'originCreatedAt',
        'assets',
      ],
      ['quoteTarget', 'quoteDigest'],
    );
    const quoteDigest = item.quoteDigest;
    if ((item.quoteTarget !== undefined) !== (quoteDigest !== undefined)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'quote target and digest must appear together',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      quoteDigest !== undefined &&
      (typeof quoteDigest !== 'string' || !/^[a-f0-9]{64}$/.test(quoteDigest))
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'invalid quote digest',
        HttpStatus.BAD_REQUEST,
      );
    }
    const authorNamespaceId = item.author?.namespaceId;
    if (
      !Number.isSafeInteger(authorNamespaceId) ||
      authorNamespaceId < 0 ||
      authorNamespaceId > 2_147_483_647 ||
      !Number.isSafeInteger(item.profileRev) ||
      item.profileRev < 0 ||
      item.profileRev > 2_147_483_647
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'federated message has an invalid namespaceId or profileRev',
        HttpStatus.BAD_REQUEST,
      );
    }
    const thread = assertFields(
      rawThread,
      isGroup ? ['account'] : ['account', 'peerAccount'],
    );
    if (
      typeof thread['account'] !== 'string' ||
      (isGroup
        ? !isValidGroupAccount(thread['account'])
        : !isValidSomfpUserAccount(thread['account'])) ||
      ('peerAccount' in thread &&
        (typeof thread['peerAccount'] !== 'string' ||
          !isValidSomfpUserAccount(thread['peerAccount'])))
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'federated message has an invalid thread address',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (isGroup) {
      const author = assertFields(item.author, ['account', 'namespaceId']);
      if (
        typeof author['account'] !== 'string' ||
        !isValidSomfpUserAccount(author['account'])
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'federated message has an invalid group author',
          HttpStatus.BAD_REQUEST,
        );
      }
    } else {
      const author = assertFields(item.author, ['ref', 'namespaceId']);
      if (
        author['ref'] !== 'THREAD_ACCOUNT' &&
        author['ref'] !== 'THREAD_PEER_ACCOUNT'
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'federated message has an invalid P2P author reference',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    if (typeof item.content !== 'string' || !Array.isArray(item.assets)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'federated message has invalid primitive fields',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      item.quoteTarget !== undefined &&
      !isFederationQuoteTarget(item.quoteTarget)
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'invalid federated reply target',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      item.contentType === ContentType.SYSTEM &&
      (item.quoteTarget !== undefined || item.quoteDigest !== undefined)
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'system messages cannot contain quotes',
        HttpStatus.BAD_REQUEST,
      );
    }
    for (const asset of item.assets) assertFields(asset, ['digest', 'bytes']);
  }
}
