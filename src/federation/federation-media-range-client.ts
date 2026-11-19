import { HttpStatus, Injectable, Logger } from '@nestjs/common';
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

class MediaResponseCleanupError extends AggregateError {
  constructor(errors: unknown[]) {
    super(errors, 'media response body cleanup failed');
  }
}

/** Fetches peer-hosted media as verified, resumable HTTP Range units. */
@Injectable()
export class FederationMediaRangeClient {
  private readonly logger = new Logger(FederationMediaRangeClient.name);

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
    signal: AbortSignal,
  ): AsyncGenerator<Buffer> {
    signal.throwIfAborted();
    const chunkBytes = this.transportConfig.get().mediaChunkBytes;
    const base = await this.discovery.resolveBase(peerDomain);
    const params = new URLSearchParams({
      fromAccount,
      fromDomain,
      toAccount,
      seq: String(sourceSeq),
    });
    const url = new URL(
      `${base}/somfp/v1/media/${digest}?${params.toString()}`,
    );
    let offset = startOffset;
    let total: number | null = null;
    let markedAlive = false;

    while (total === null || offset < total) {
      signal.throwIfAborted();
      const requestedEnd =
        total === null
          ? offset + chunkBytes - 1
          : Math.min(offset + chunkBytes - 1, total - 1);
      let retries = 0;
      for (;;) {
        let unit: FederationMediaRangeUnit | undefined;
        let buffer: Buffer;
        let bodyOwnedByReader = false;
        const unitErrors: unknown[] = [];
        try {
          unit = await this.requestUnit(
            url,
            peerDomain,
            offset,
            requestedEnd,
            signal,
          );
          if (unit.total !== declaredBytes) {
            throw new Error('media declared size does not match Content-Range');
          }
          if (total !== null && unit.total !== total)
            throw new Error('media total changed during transfer');
          const unitLength = unit.end - unit.start + 1;
          const pieces: Buffer[] = [];
          let received = 0;
          bodyOwnedByReader = true;
          for await (const piece of this.webBody(unit.res, signal)) {
            signal.throwIfAborted();
            received += piece.length;
            if (received > unitLength)
              throw new CasOversizeError(BigInt(received - unitLength));
            pieces.push(piece);
          }
          signal.throwIfAborted();
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
          unitErrors.push(error);
          if (error instanceof MediaResponseCleanupError) throw error;
          signal.throwIfAborted();
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
          if (unit && !bodyOwnedByReader) {
            await this.cancelResponse(unit.res, signal, unitErrors);
          }
        }
        signal.throwIfAborted();
        total = unit.total;
        if (!markedAlive) {
          await this.lifecycle.markContactSuccess(peerDomain);
          markedAlive = true;
        }
        signal.throwIfAborted();
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
    signal: AbortSignal,
  ): Promise<FederationMediaRangeUnit> {
    signal.throwIfAborted();
    const operationStartedAt = new Date();
    const headers = await this.signature.signOutbound({
      method: 'GET',
      url,
      body: '',
    });
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await this.discovery.request(url, {
        method: 'GET',
        headers: { ...headers, range: `bytes=${start}-${end}` },
        signal,
      });
    } catch (error) {
      signal.throwIfAborted();
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

    if (signal.aborted) {
      // A transport adapter may finish after cancellation. Release its response instead
      // of interpreting late headers as peer health or yielding them to the writer.
      await this.cancelResponse(response, signal, [signal.reason]);
      signal.throwIfAborted();
    }
    if (response.status === HttpStatus.OK) {
      await this.lifecycle.markContactSuccess(peerDomain);
      const error = await this.readErrorEnvelope(response, signal);
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
        await this.cancelResponse(response, signal, [error]);
        throw error;
      }
    }

    const error = await this.readErrorEnvelope(response, signal);
    signal.throwIfAborted();
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
    signal: AbortSignal,
  ): Promise<{ code: number; message?: string; data?: unknown } | undefined> {
    const contentType = (response.headers.get('content-type') ?? '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      await this.cancelResponse(response, signal);
      signal.throwIfAborted();
      return undefined;
    }
    const pieces: Buffer[] = [];
    let bytes = 0;
    for await (const piece of this.webBody(response, signal)) {
      bytes += piece.length;
      if (bytes > 64 * 1024) return undefined;
      pieces.push(piece);
    }
    signal.throwIfAborted();
    const text = Buffer.concat(pieces, bytes).toString('utf8');
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

  private async cancelResponse(
    response: Response,
    signal: AbortSignal,
    precedingErrors: unknown[] = [],
  ): Promise<void> {
    try {
      await response.body?.cancel(signal.reason);
    } catch (cause) {
      const error = new MediaResponseCleanupError([...precedingErrors, cause]);
      this.logger.error('Could not cancel media response body', error);
      throw error;
    }
  }

  private async *webBody(
    response: Response,
    signal: AbortSignal,
  ): AsyncGenerator<Buffer> {
    if (signal.aborted) {
      await this.cancelResponse(response, signal, [signal.reason]);
      signal.throwIfAborted();
    }
    if (!response.body) return;
    const reader = response.body.getReader();
    let finished = false;
    let cancellation: Promise<void> | undefined;
    const cleanupErrors: unknown[] = [];
    const readErrors: unknown[] = [];
    const cancel = () => {
      // Observe rejection immediately even while read() is still pending. The finally
      // block drains cancellation before releasing the reader or allowing another unit.
      cancellation ??= reader.cancel(signal.reason).catch((error: unknown) => {
        cleanupErrors.push(error);
      });
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) {
          finished = true;
          return;
        }
        yield Buffer.from(value);
      }
    } catch (error) {
      readErrors.push(error);
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      if (!finished) cancel();
      await cancellation;
      reader.releaseLock();
      // Cancelling an already errored Web Stream rejects with the same stored read
      // error. That is not a second cleanup failure and retains normal transport retry.
      const distinctCleanupErrors = cleanupErrors.filter(
        (error) => !readErrors.includes(error),
      );
      if (distinctCleanupErrors.length) {
        const error = new MediaResponseCleanupError([
          ...readErrors,
          ...distinctCleanupErrors,
        ]);
        this.logger.error('Could not cancel media response body', error);
        throw error;
      }
    }
  }
}
