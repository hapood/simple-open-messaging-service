import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { FastifyInstance } from 'fastify';
import { BusinessCode } from '../common/business-code.js';

/** Process-wide inbound admission, closed before imported business modules stop. */
@Injectable()
export class HttpAdmissionService implements OnModuleDestroy {
  private stopping = false;

  onModuleDestroy(): void {
    this.stopping = true;
  }

  register(server: FastifyInstance): void {
    // Run before authentication, body parsing, or any route-owned work, including
    // static and federation routes which do not pass through Nest controllers.
    server.addHook('onRequest', async (request, reply) => {
      if (!this.stopping) return;
      if (request.raw.httpVersionMajor === 1)
        reply.header('connection', 'close');
      reply.header('retry-after', '1');
      return reply.code(503).send({
        code: BusinessCode.INTERNAL,
        message: 'service shutting down',
        data: null,
      });
    });
  }
}
