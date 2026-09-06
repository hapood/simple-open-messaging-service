import { HttpStatus, Injectable } from '@nestjs/common';
import { BusinessCode } from '../common/business-code.js';
import { DiscoveryService } from './discovery.service.js';
import {
  FederationTransportError,
  S2sResponseError,
} from './federation-errors.js';
import { FederationRecognitionService } from './federation-recognition.service.js';
import { FederationTransportConfigService } from './federation-transport-config.service.js';
import { SignatureService } from './signature.service.js';
import { FederationPeerLifecycle } from './federation-peer-lifecycle.js';

export interface FederationPostOptions {
  signatureExpiresAtSec?: number;
}

export interface FederationPeerHttpLifecycle {
  isFatalPeerCode(code: unknown): code is number;
  markContactSuccess(domain: string): Promise<void>;
  markPeerHalted(domain: string, code: number, message: unknown): Promise<void>;
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

  async post(
    path: string,
    body: string,
    peerDomain: string,
    options: FederationPostOptions = {},
  ): Promise<void> {
    const base = await this.discovery.resolveBase(peerDomain);
    await this.postUrl(new URL(`${base}${path}`), body, peerDomain, options);
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
          signal: AbortSignal.timeout(
            this.transportConfig.get().callTimeoutSec * 1000,
          ),
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

      const errorBody = await response.json().catch(() => undefined);
      const code =
        typeof errorBody?.code === 'number' ? errorBody.code : undefined;
      if (status === HttpStatus.SERVICE_UNAVAILABLE) {
        await this.recognition.markTransportDegraded(
          peerDomain,
          `POST HTTP ${status}`,
          operationStartedAt,
        );
      } else if (
        status === HttpStatus.CONFLICT &&
        this.lifecycle.isFatalPeerCode(code)
      ) {
        await this.lifecycle.markPeerHalted(
          peerDomain,
          code,
          errorBody?.message,
        );
      }
      throw new S2sResponseError(
        `S2S POST to ${peerDomain} rejected: HTTP ${status}`,
        status,
        code,
        errorBody?.data,
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
          signal: AbortSignal.timeout(
            this.transportConfig.get().callTimeoutSec * 1000,
          ),
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
        const status = response.status;
        const errorBody = await response.json().catch(() => undefined);
        const code =
          typeof errorBody?.code === 'number' ? errorBody.code : undefined;
        if (status === HttpStatus.SERVICE_UNAVAILABLE) {
          await this.recognition.markTransportDegraded(
            peerDomain,
            `GET ${path} HTTP ${status}`,
            operationStartedAt,
          );
        } else if (
          status === HttpStatus.CONFLICT &&
          this.lifecycle.isFatalPeerCode(code)
        ) {
          await this.lifecycle.markPeerHalted(
            peerDomain,
            code,
            errorBody?.message,
          );
        }
        throw new S2sResponseError(
          `S2S GET ${path} from ${peerDomain} rejected: HTTP ${status}`,
          status,
          code,
          errorBody?.data,
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
