import { HttpStatus, Injectable } from '@nestjs/common';
import { BusinessCode } from '../common/business-code.js';
import { DiscoveryService } from './discovery.service.js';
import {
  FederationTransportError,
  S2sResponseError,
} from './federation-errors.js';
import { isRetryableFederationNetworkError } from './federation-http-scheduler.js';
import { FederationRecognitionService } from './federation-recognition.service.js';
import { FederationTransportConfigService } from './federation-transport-config.service.js';
import { CasOversizeError } from '../upload/upload.service.js';
import { contentDigest, SignatureService } from './signature.service.js';
import { FederationPeerLifecycle } from './federation-peer-lifecycle.js';

export interface FederationMediaRangeUnit {
  res: Response;
  start: number;
  end: number;
  total: number;
  contentDigest?: string;
}

/** Fetches peer-hosted media as verified, resumable HTTP Range units. */
@Injectable()
export class FederationMediaRangeClient {
  constructor(
    private readonly signature: SignatureService,
    private readonly discovery: DiscoveryService,
    private readonly recognition: FederationRecognitionService,
    private readonly transportConfig: FederationTransportConfigService,
    private readonly lifecycle: FederationPeerLifecycle,
  ) {}

  async *fetch(
    peerDomain: string,
    digest: string,
    fromAccount: string,
    fromDomain: string,
    toAccount: string,
    sourceSeq: number,
    startOffset: number,
    declaredBytes: number,
  ): AsyncGenerator<Buffer> {
    const chunkBytes = this.transportConfig.get().mediaChunkBytes;
    const base = await this.discovery.resolveBase(peerDomain);
    const params = new URLSearchParams({
      fromAccount,
      fromDomain,
      toAccount,
      seq: String(sourceSeq),
    });
    const url = new URL(`${base}/s2s/v1/media/${digest}?${params.toString()}`);
    let offset = startOffset;
    let total: number | null = null;
    let markedAlive = false;

    while (total === null || offset < total) {
      const requestedEnd =
        total === null
          ? offset + chunkBytes - 1
          : Math.min(offset + chunkBytes - 1, total - 1);
      let retries = 0;
      for (;;) {
        let unit: FederationMediaRangeUnit | undefined;
        let buffer: Buffer;
        try {
          unit = await this.requestUnit(url, peerDomain, offset, requestedEnd);
          if (unit.total !== declaredBytes) {
            throw new Error('media declared size does not match Content-Range');
          }
          if (total !== null && unit.total !== total)
            throw new Error('media total changed during transfer');
          const unitLength = unit.end - unit.start + 1;
          const pieces: Buffer[] = [];
          let received = 0;
          for await (const piece of this.webBody(unit.res)) {
            received += piece.length;
            if (received > unitLength)
              throw new CasOversizeError(BigInt(received - unitLength));
            pieces.push(piece);
          }
          buffer = Buffer.concat(pieces);
          if (buffer.length !== unitLength) {
            throw new Error(
              `unit byte mismatch (got ${buffer.length}, expected ${unitLength})`,
            );
          }
          if (
            unit.contentDigest &&
            contentDigest(buffer) !== unit.contentDigest
          ) {
            throw new Error(`unit digest mismatch at offset ${offset}`);
          }
        } catch (error) {
          // Retry transport failures before headers as well as body/verification
          // failures, but do not repeat permanent peer rejections.
          if (error instanceof CasOversizeError) throw error;
          if (!unit && !isRetryableFederationNetworkError(error)) throw error;
          if (++retries > this.transportConfig.get().mediaMaxChunkRetries) {
            throw new Error(
              `media fetch retries exhausted at offset ${offset}: ${(error as Error).message}`,
              { cause: error },
            );
          }
          continue;
        } finally {
          if (unit && !unit.res.body?.locked) {
            await unit.res.body?.cancel().catch(() => undefined);
          }
        }
        total = unit.total;
        if (!markedAlive) {
          await this.lifecycle.markContactSuccess(peerDomain);
          markedAlive = true;
        }
        yield buffer;
        offset += buffer.length;
        break;
      }
    }
  }

  async requestUnit(
    url: URL,
    peerDomain: string,
    start: number,
    end: number,
  ): Promise<FederationMediaRangeUnit> {
    const operationStartedAt = new Date();
    const headers = await this.signature.signOutbound({
      method: 'GET',
      url,
      body: '',
    });
    let response: Response;
    try {
      response = await this.discovery.request(url, {
        method: 'GET',
        headers: { ...headers, range: `bytes=${start}-${end}` },
      });
    } catch (error) {
      await this.recognition.markTransportDegraded(
        peerDomain,
        `GET media network/timeout: ${(error as Error).message}`,
        operationStartedAt,
      );
      throw new FederationTransportError(
        `S2S media from ${peerDomain} failed (network/timeout): ${(error as Error).message}`,
        { cause: error },
      );
    }

    if (response.status === HttpStatus.OK) {
      await this.lifecycle.markContactSuccess(peerDomain);
      const error = await this.readErrorEnvelope(response);
      if (error) {
        throw new S2sResponseError(
          `S2S media from ${peerDomain} returned business code ${error.code}`,
          response.status,
          error.code,
          error.data,
        );
      }
      throw new S2sResponseError(
        'S2S media peer ignored required Range request',
        response.status,
        BusinessCode.FEDERATION_MALFORMED,
      );
    }
    if (response.status === HttpStatus.PARTIAL_CONTENT) {
      try {
        return await this.parsePartialContent(
          response,
          start,
          end,
          peerDomain,
          operationStartedAt,
        );
      } catch (error) {
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }
    }

    const error = await this.readErrorEnvelope(response);
    const code = error?.code;
    if (
      response.status === HttpStatus.SERVICE_UNAVAILABLE ||
      response.status >= 500
    ) {
      await this.recognition.markTransportDegraded(
        peerDomain,
        `GET media HTTP ${response.status}`,
        operationStartedAt,
      );
    } else if (
      response.status === HttpStatus.CONFLICT &&
      this.lifecycle.isFatalPeerCode(code)
    ) {
      await this.lifecycle.markPeerHalted(peerDomain, code, error?.message);
    }
    if (response.status === HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE) {
      const contentRange = response.headers.get('content-range') ?? '';
      if (
        code !== BusinessCode.FEDERATION_RANGE_NOT_SATISFIABLE ||
        !/^bytes \*\/\d+$/.test(contentRange)
      ) {
        throw new S2sResponseError(
          'S2S media returned malformed 416 response',
          response.status,
          BusinessCode.FEDERATION_MALFORMED,
        );
      }
    }
    throw new S2sResponseError(
      `S2S media from ${peerDomain} rejected: HTTP ${response.status}`,
      response.status,
      code,
      error?.data,
    );
  }

  private async parsePartialContent(
    response: Response,
    start: number,
    end: number,
    peerDomain: string,
    operationStartedAt: Date,
  ): Promise<FederationMediaRangeUnit> {
    const contentRange = response.headers.get('content-range') ?? '';
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
    if (!match) {
      await this.recognition.markTransportDegraded(
        peerDomain,
        `GET media 206 unparseable Content-Range: ${contentRange}`,
        operationStartedAt,
      );
      throw new Error(
        `S2S media 206 without parseable Content-Range: ${contentRange}`,
      );
    }
    const returnedStart = Number(match[1]);
    const returnedEnd = Number(match[2]);
    const returnedTotal = Number(match[3]);
    const digest = response.headers.get('content-digest');
    if (
      !Number.isSafeInteger(returnedStart) ||
      !Number.isSafeInteger(returnedEnd) ||
      !Number.isSafeInteger(returnedTotal) ||
      returnedStart !== start ||
      returnedEnd < returnedStart ||
      returnedEnd > end ||
      returnedEnd >= returnedTotal
    ) {
      throw new Error(
        `S2S media returned unexpected Content-Range: ${contentRange} for bytes=${start}-${end}`,
      );
    }
    if (digest !== null && !/^sha-256=:[A-Za-z0-9+/]{43}=:$/i.test(digest)) {
      throw new Error('S2S media 206 with an invalid Content-Digest');
    }
    return {
      res: response,
      start: returnedStart,
      end: returnedEnd,
      total: returnedTotal,
      contentDigest: digest ?? undefined,
    };
  }

  private async readErrorEnvelope(
    response: Response,
  ): Promise<{ code: number; message?: string; data?: unknown } | undefined> {
    const contentType = (response.headers.get('content-type') ?? '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > 64 * 1024) return undefined;
    try {
      const parsed = JSON.parse(text) as {
        code?: unknown;
        message?: unknown;
        data?: unknown;
      };
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof parsed.code !== 'number' ||
        !Number.isSafeInteger(parsed.code) ||
        parsed.code === BusinessCode.OK ||
        typeof parsed.message !== 'string'
      ) {
        return undefined;
      }
      return { code: parsed.code, message: parsed.message, data: parsed.data };
    } catch {
      return undefined;
    }
  }

  private async *webBody(response: Response): AsyncGenerator<Buffer> {
    if (!response.body) return;
    for await (const piece of response.body as unknown as AsyncIterable<Uint8Array>) {
      yield Buffer.from(piece);
    }
  }
}
