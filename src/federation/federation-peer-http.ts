import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { BusinessCode } from '../common/business-code.js';
import { DiscoveryService } from './discovery.service.js';
import {
  FederationTransportError,
  parsePeerErrorBody,
  parseStrictPeerErrorEnvelope,
  S2sResponseError,
} from './federation-errors.js';
import { FederationRecognitionService } from './federation-recognition.service.js';
import { FederationTransportConfigService } from './federation-transport-config.service.js';
import { SignatureService } from './signature.service.js';
import { FederationPeerLifecycle } from './federation-peer-lifecycle.js';

export interface FederationPostOptions {
  signatureExpiresAtSec?: number;
}

/** Signed JSON transport shared by federation control-plane and feed requests. */
@Injectable()
export class FederationPeerHttp {
  constructor(
    private readonly signature: SignatureService,
    private readonly discovery: DiscoveryService,
    private readonly recognition: FederationRecognitionService,
    private readonly transportConfig: FederationTransportConfigService,
    private readonly lifecycle: FederationPeerLifecycle,
  ) {}

  private readonly logger = new Logger(FederationPeerHttp.name);

  async post(
    path: string,
    body: string,
    peerDomain: string,
    options: FederationPostOptions = {},
  ): Promise<void> {
    const base = await this.discovery.resolveBase(peerDomain);
    await this.postUrl(new URL(`${base}${path}`), body, peerDomain, options);
  }

  async postJson<T>(
    path: string,
    body: string,
    peerDomain: string,
    _options: FederationPostOptions = {},
  ): Promise<T> {
    const base = await this.discovery.resolveBase(peerDomain);
    const url = new URL(`${base}${path}`);
    const release = await this.discovery.acquireRequestSlot(peerDomain);
    try {
      const operationStartedAt = new Date();
      const headers = await this.signature.signOutbound({
        method: 'POST',
        url,
        body,
      });
      let response: Response;
      try {
        response = await this.discovery.request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body,
        });
      } catch (error) {
        await this.recognition.markTransportDegraded(
          peerDomain,
          `POST network/timeout: ${(error as Error).message}`,
          operationStartedAt,
        );
        throw new FederationTransportError(
          `S2S POST to ${peerDomain} failed (network/timeout): ${(error as Error).message}`,
          { cause: error },
        );
      }
      if (response.status >= 200 && response.status < 300) {
        await this.lifecycle.markContactSuccess(peerDomain);
        if (response.status === HttpStatus.NO_CONTENT) return undefined as T;
        const envelope = (await response.json().catch(() => undefined)) as
          | { code?: unknown; data?: unknown }
          | undefined;
        if (envelope?.code !== BusinessCode.OK) {
          throw new S2sResponseError(
            `S2S POST to ${peerDomain} returned business code ${String(envelope?.code)}`,
            response.status,
            typeof envelope?.code === 'number'
              ? envelope.code
              : BusinessCode.FEDERATION_MALFORMED,
            envelope?.data,
          );
        }
        return envelope.data as T;
      }
      await this.throwRejectedResponse(
        `POST to ${peerDomain}`,
        peerDomain,
        response.status,
        response,
        operationStartedAt,
      );
      throw new Error('unreachable');
    } finally {
      release();
    }
  }
  async postUrl(
    url: URL,
    body: string,
    peerDomain: string,
    options: FederationPostOptions = {},
  ): Promise<void> {
    const release = await this.discovery.acquireRequestSlot(peerDomain);
    try {
      const operationStartedAt = new Date();
      const headers = await this.signature.signOutbound(
        {
          method: 'POST',
          url,
          body,
        },
        operationStartedAt,
        options.signatureExpiresAtSec,
      );
      let response: Response;
      try {
        response = await this.discovery.request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body,
        });
      } catch (error) {
        await this.recognition.markTransportDegraded(
          peerDomain,
          `POST network/timeout: ${(error as Error).message}`,
          operationStartedAt,
        );
        throw new FederationTransportError(
          `S2S POST to ${peerDomain} failed (network/timeout): ${(error as Error).message}`,
          { cause: error },
        );
      }

      const status = response.status;
      if (status >= 200 && status < 300) {
        await this.lifecycle.markContactSuccess(peerDomain);
        if (status !== HttpStatus.NO_CONTENT) {
          const envelope = (await response.json().catch(() => undefined)) as
            | { code?: unknown; data?: unknown }
            | undefined;
          if (envelope?.code !== BusinessCode.OK) {
            throw new S2sResponseError(
              `S2S POST to ${peerDomain} returned business code ${String(envelope?.code)}`,
              status,
              typeof envelope?.code === 'number'
                ? envelope.code
                : BusinessCode.FEDERATION_MALFORMED,
              envelope?.data,
            );
          }
        }
        return;
      }

      await this.throwRejectedResponse(
        `POST to ${peerDomain}`,
        peerDomain,
        status,
        response,
        operationStartedAt,
      );
    } finally {
      release();
    }
  }

  async get<T>(
    path: string,
    peerDomain: string,
    maxResponseBytes?: number,
  ): Promise<T> {
    const base = await this.discovery.resolveBase(peerDomain);
    const url = new URL(`${base}${path}`);
    const release = await this.discovery.acquireRequestSlot(peerDomain);
    try {
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
          headers: { ...headers },
        });
      } catch (error) {
        await this.recognition.markTransportDegraded(
          peerDomain,
          `GET ${path} network/timeout: ${(error as Error).message}`,
          operationStartedAt,
        );
        throw new FederationTransportError(
          `S2S GET ${path} from ${peerDomain} failed (network/timeout): ${(error as Error).message}`,
          { cause: error },
        );
      }

      if (!response.ok) {
        await this.throwRejectedResponse(
          `GET from ${peerDomain} ${path}`,
          peerDomain,
          response.status,
          response,
          operationStartedAt,
        );
      }

      await this.lifecycle.markContactSuccess(peerDomain);
      if (maxResponseBytes !== undefined) {
        const declared = Number(response.headers.get('content-length') ?? 0);
        if (declared > maxResponseBytes) {
          throw this.responseTooLarge(path, maxResponseBytes);
        }
      }
      const body = await this.readBody(response, path, maxResponseBytes);
      const envelope = body as { code?: number; data?: unknown };
      if (
        typeof envelope?.code === 'number' &&
        envelope.code !== BusinessCode.OK
      ) {
        throw new S2sResponseError(
          `S2S GET ${path} from ${peerDomain} business error: code ${envelope.code}`,
          response.status,
          envelope.code,
          envelope.data,
        );
      }
      return (envelope?.data ?? envelope) as T;
    } finally {
      release();
    }
  }

  /** Shared non-2xx handling: parse the peer's best-effort error body, record
   * transport degradation or a fatal peer halt, and throw. `where` renders the
   * request in log and error prose, e.g. `POST to ${peerDomain}`. */
  private async throwRejectedResponse(
    where: string,
    peerDomain: string,
    status: number,
    response: Response,
    operationStartedAt: Date,
  ): Promise<never> {
    let raw: unknown;
    let bodyNote = 'an absent error body';
    try {
      raw = await response.json();
      bodyNote = `an error body without a numeric code: ${JSON.stringify(raw).slice(0, 200)}`;
    } catch (error) {
      bodyNote = `an unparsable error body: ${(error as Error).message}`;
    }
    const errorBody = parsePeerErrorBody(raw);
    if (errorBody.code === undefined) {
      // The protocol requires `code` on every non-2xx body; warn so a peer
      // serving HTML error pages or junk stays diagnosable.
      this.logger.warn(`S2S ${where} returned HTTP ${status} with ${bodyNote}`);
    }
    // Only a strictly parsed closed envelope may drive the fatal decision.
    const strict = parseStrictPeerErrorEnvelope(raw);
    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      await this.recognition.markTransportDegraded(
        peerDomain,
        `${where} HTTP ${status}`,
        operationStartedAt,
      );
    } else if (
      status === HttpStatus.CONFLICT &&
      strict &&
      this.lifecycle.isFatalPeerCode(strict.code)
    ) {
      await this.lifecycle.markPeerHalted(
        peerDomain,
        strict.code,
        strict.message,
      );
    }
    throw new S2sResponseError(
      `S2S ${where} rejected: HTTP ${status}`,
      status,
      errorBody.code,
      errorBody.data,
    );
  }

  private async readBody(
    response: Response,
    path: string,
    maxResponseBytes?: number,
  ): Promise<unknown> {
    if (maxResponseBytes === undefined) return response.json();
    const text = await response.text();
    if (Buffer.byteLength(text) > maxResponseBytes) {
      throw this.responseTooLarge(path, maxResponseBytes);
    }
    return JSON.parse(text) as unknown;
  }

  private responseTooLarge(
    path: string,
    maxResponseBytes: number,
  ): S2sResponseError {
    return new S2sResponseError(
      `S2S GET ${path} response exceeds ${maxResponseBytes} bytes`,
      HttpStatus.OK,
      BusinessCode.FEDERATION_PAYLOAD_TOO_LARGE,
    );
  }
}
