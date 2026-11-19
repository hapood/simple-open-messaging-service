import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Transform } from 'node:stream';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { CLIENT_API_PREFIX } from '../federation/federation-protocol.js';
import { MEDIA_UPLOAD_CHUNK_BYTES } from '../../shared/media-upload-limits.js';
import type {
  UploadActivityService,
  UploadActivityHandle,
  UploadReceiveHandle,
} from './upload-activity.service.js';

const receivedBodies = new WeakMap<Buffer, UploadReceiveHandle>();

/** Append must compare this attempt with its freshly locked domain row before writing bytes. */
export function uploadBodyActivity(
  body: Buffer,
): UploadReceiveHandle | undefined {
  return receivedBodies.get(body);
}

/** Authentication/ownership is injected by bootstrap; the runtime has no domain-service dependency. */
export function registerUploadActivityTransport(
  fastify: FastifyInstance,
  activity: UploadActivityService,
  authorize: (
    request: FastifyRequest,
    id: string,
  ) => Promise<UploadActivityHandle>,
): void {
  const requests = new WeakMap<
    FastifyRequest,
    { receive: UploadReceiveHandle; cleanup: () => void }
  >();
  fastify.addHook('preParsing', async (request, reply, payload) => {
    if (
      request.method !== 'PUT' ||
      request.routeOptions.url !== `/${CLIENT_API_PREFIX}/uploads/resumable/:id`
    )
      return payload;
    if (
      request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !==
      'application/octet-stream'
    ) {
      reply.code(415).send({
        code: BusinessCode.VALIDATION_FAILED,
        message: 'upload chunks require application/octet-stream',
        data: null,
      });
      return payload;
    }
    const { id } = request.params as { id: string };
    try {
      // Preserve the exact registration across this await: retry can reuse the same storage key.
      const handle = await authorize(request, id);
      if (request.raw.destroyed) return payload;
      let started = false;
      const stream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          activity.activity(receive!, chunk.length);
          this.push(chunk);
          callback();
        },
        flush(callback) {
          activity.endReceiving(receive!);
          callback();
        },
      });
      // Do not put the incoming stream in flowing mode before Fastify installs its buffer parser.
      const read = stream._read;
      stream._read = function (size) {
        if (!started) {
          started = true;
          payload.pipe(stream);
        }
        read.call(this, size);
      };
      const receive = activity.beginReceiving(handle, (reason) => {
        stream.destroy(
          Object.assign(
            new Error(
              reason === 'idle'
                ? 'upload receive timed out'
                : 'upload attempt stopped',
            ),
            {
              statusCode: reason === 'idle' ? 408 : 409,
            },
          ),
        );
      });
      if (!receive) {
        stream.destroy();
        reply.code(409).send({
          code: BusinessCode.ALREADY_EXISTS,
          message: 'upload is not waiting for a chunk',
          data: null,
        });
        return payload;
      }
      const abort = () =>
        stream.destroy(
          Object.assign(new Error('upload body disconnected'), {
            statusCode: 400,
          }),
        );
      const error = (cause: Error) => stream.destroy(cause);
      const cleanup = () => {
        payload.unpipe(stream);
        payload.off('error', error);
        request.raw.off('aborted', abort);
        activity.releaseReceiving(receive!);
        // Early length/size rejection may occur before Fastify ever reads the wrapper.
        stream.destroy();
      };
      payload.once('error', error);
      request.raw.once('aborted', abort);
      // Keep an error listener after Fastify removes its parser listener on size rejection.
      stream.on('error', cleanup);
      requests.set(request, { receive, cleanup });
      return stream;
    } catch (error) {
      // These hooks run before Nest's exception filter.
      if (!(error instanceof BusinessException)) throw error;
      reply.code(error.getStatus()).send({
        code: error.bizCode,
        message: error.message,
        data: error.data,
      });
      return payload;
    }
  });
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MEDIA_UPLOAD_CHUNK_BYTES },
    (request, body, done) => {
      const context = requests.get(request);
      if (context && Buffer.isBuffer(body))
        receivedBodies.set(body, context.receive);
      done(null, body);
    },
  );
  fastify.addHook('onResponse', async (request) => {
    requests.get(request)?.cleanup();
    requests.delete(request);
  });
}
