import { HttpStatus, Injectable } from '@nestjs/common';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { ContentType } from '../database/enums.js';
import { UploadService } from '../upload/upload.service.js';
import { federatedContentDigests } from './federated-message-content.js';
import type { FederationMessageFeedMessage } from './federation-message-feed.service.js';

/** Validates the closed wire shape and CAS descriptor manifest of an inbound message item. */
@Injectable()
export class FederationInboundMessageValidatorService {
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
        isGroup ? 'author' : 'authorRef',
        'seq',
        'profileRev',
        'originSeq',
        'contentType',
        'content',
        'createdAt',
        'originCreatedAt',
        ...(item.contentType === ContentType.CALL ? ['clientMessageId'] : []),
        'assets',
      ],
      ['quoteTarget'],
    );
    if (
      !Number.isSafeInteger(item.profileRev) ||
      item.profileRev < 0 ||
      item.profileRev > 2_147_483_647
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'federated message has an invalid profileRev',
        HttpStatus.BAD_REQUEST,
      );
    }
    const thread = assertFields(
      rawThread,
      isGroup ? ['account'] : ['account', 'peerAccount'],
    );
    if (
      typeof thread['account'] !== 'string' ||
      ('peerAccount' in thread && typeof thread['peerAccount'] !== 'string')
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'federated message has an invalid thread address',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (isGroup) {
      const author = assertFields(
        (item as Extract<FederationMessageFeedMessage, { author: unknown }>)
          .author,
        ['account', 'domain'],
      );
      if (
        typeof author['account'] !== 'string' ||
        typeof author['domain'] !== 'string'
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'federated message has an invalid group author',
          HttpStatus.BAD_REQUEST,
        );
      }
    } else if (
      !['THREAD_ACCOUNT', 'THREAD_PEER_ACCOUNT'].includes(
        (item as { authorRef?: string }).authorRef ?? '',
      )
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'federated message has an invalid P2P author reference',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (typeof item.content !== 'string' || !Array.isArray(item.assets)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'federated message has invalid primitive fields',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (item.quoteTarget) assertFields(item.quoteTarget, ['targetSeq']);
    for (const asset of item.assets) assertFields(asset, ['digest', 'bytes']);
  }
}
