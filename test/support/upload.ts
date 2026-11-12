import request from 'supertest';
import { randomUUID } from 'node:crypto';

/** Exercise the public sequential protocol and expose the final per-part payload to callers. */
export async function uploadMessagePart(
  server: Parameters<typeof request>[0],
  token: string,
  clientMessageId: string,
  bytes: Buffer,
  filename: string,
  intent: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE',
  options: { position?: number; partId?: string; mimeType?: string } = {},
) {
  const mimeType =
    options.mimeType ??
    {
      IMAGE: 'image/png',
      VIDEO: 'video/mp4',
      AUDIO: 'audio/ogg',
      FILE: 'application/octet-stream',
    }[intent];
  const init = await request(server)
    .post('/api/v1/uploads/resumable/init')
    .set('Authorization', `Bearer ${token}`)
    .send({
      clientMessageId,
      partId: options.partId ?? randomUUID(),
      position: options.position ?? 0,
      intent,
      originalName: filename,
      mimeType,
      totalBytes: bytes.length,
    });
  if (init.body.code !== 0) return init;
  const { uploadId, chunkSize, offset } = init.body.data;
  for (let start = offset; start < bytes.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, bytes.length);
    const chunk = await request(server)
      .put(`/api/v1/uploads/resumable/${uploadId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/octet-stream')
      .set('Content-Range', `bytes ${start}-${end - 1}/${bytes.length}`)
      .send(bytes.subarray(start, end));
    if (chunk.body.code !== 0) return chunk;
  }
  const completed = await request(server)
    .post(`/api/v1/uploads/resumable/${uploadId}/complete`)
    .set('Authorization', `Bearer ${token}`)
    .send({});
  if (completed.body.code === 0)
    completed.body.data = completed.body.data.result;
  return completed;
}
