import { consumeSse, type SseFrame } from '../../../shared/sse-client';
import { consumeHttpStream } from '../../../shared/http-stream';

export function consumeAdminSse(
  url: string,
  options: {
    signal: AbortSignal;
    onResponse?: (response: Response) => void;
    onOpen?: () => void;
    onFrame: (frame: SseFrame) => void;
  },
): Promise<void> {
  return consumeSse(url, { ...options, transport: consumeHttpStream });
}
