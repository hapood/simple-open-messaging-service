import { HttpException, HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusinessCode } from './business-code.js';
import { BusinessException } from './business.exception.js';
import { AllExceptionsFilter } from './exception.filter.js';

describe('AllExceptionsFilter federation mapping', () => {
  afterEach(() => vi.restoreAllMocks());

  function capture(exception: unknown, url = '/s2s/v1/messages') {
    const send = vi.fn();
    const reply = {
      sent: false,
      status: vi.fn().mockReturnThis(),
      send,
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ url }),
        getResponse: () => reply,
      }),
    } as unknown as ArgumentsHost;

    new AllExceptionsFilter().catch(exception, host);
    return { reply, send };
  }

  it('forces ordinary federation business refusals onto HTTP 200', () => {
    const { reply, send } = capture(
      new BusinessException(
        BusinessCode.FORBIDDEN,
        'not visible',
        HttpStatus.FORBIDDEN,
      ),
    );

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(send).toHaveBeenCalledWith({
      code: BusinessCode.FORBIDDEN,
      message: 'not visible',
      data: null,
    });
  });

  it('derives protocol status from the federation code instead of the thrown status', () => {
    const { reply, send } = capture(
      new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'bad signature metadata',
        HttpStatus.UNAUTHORIZED,
      ),
    );

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(send).toHaveBeenCalledWith({
      code: BusinessCode.FEDERATION_MALFORMED,
      message: 'bad signature metadata',
      data: null,
    });
  });

  it.each([
    [BusinessCode.NOT_FOUND, HttpStatus.OK],
    [BusinessCode.FEDERATION_RECOGNITION_REQUIRED, HttpStatus.UNAUTHORIZED],
    [BusinessCode.FEDERATION_BAD_SIGNATURE, HttpStatus.UNAUTHORIZED],
    [BusinessCode.FEDERATION_BINDING_VIOLATION, HttpStatus.UNAUTHORIZED],
    [BusinessCode.FEDERATION_PEER_BLOCKED, HttpStatus.CONFLICT],
    [BusinessCode.FEDERATION_IDENTITY_MISMATCH, HttpStatus.CONFLICT],
    [BusinessCode.FEDERATION_PROTOCOL_VERSION_UNSUPPORTED, HttpStatus.CONFLICT],
    [BusinessCode.RATE_LIMITED, HttpStatus.SERVICE_UNAVAILABLE],
    [BusinessCode.INTERNAL, HttpStatus.SERVICE_UNAVAILABLE],
    [
      BusinessCode.FEDERATION_LOCAL_IDENTITY_LOST,
      HttpStatus.SERVICE_UNAVAILABLE,
    ],
  ])('maps federation code %i to HTTP %i', (code, expectedStatus) => {
    const { reply } = capture(
      new BusinessException(code, 'classified', HttpStatus.I_AM_A_TEAPOT),
    );

    expect(reply.status).toHaveBeenCalledWith(expectedStatus);
  });

  it('maps framework request-shape failures to malformed federation requests', () => {
    const error = Object.assign(new Error('body too large'), {
      statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
    });
    const { reply, send } = capture(error);

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(send).toHaveBeenCalledWith({
      code: BusinessCode.FEDERATION_MALFORMED,
      message: 'malformed federation request',
      data: null,
    });
  });

  it('maps unexpected federation failures to HTTP 503 INTERNAL', () => {
    const { reply, send } = capture(new Error('database offline'));

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(send).toHaveBeenCalledWith({
      code: BusinessCode.INTERNAL,
      message: 'federation service temporarily unavailable',
      data: null,
    });
  });

  it('maps generic federation throttling to the registered availability result', () => {
    const { reply, send } = capture(
      new HttpException('too many requests', HttpStatus.TOO_MANY_REQUESTS),
    );

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(send).toHaveBeenCalledWith({
      code: BusinessCode.RATE_LIMITED,
      message: 'federation request rate limited',
      data: null,
    });
  });

  it('keeps the client API mapping unchanged', () => {
    const { reply, send } = capture(
      new BusinessException(
        BusinessCode.FORBIDDEN,
        'client forbidden',
        HttpStatus.FORBIDDEN,
      ),
      '/api/v1/admin/action',
    );

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(send).toHaveBeenCalledWith({
      code: BusinessCode.FORBIDDEN,
      message: 'client forbidden',
      data: null,
    });
  });
});
