import { consumeSse, type SseFrame } from '../../../../shared/sse-client';
import { appHttpStream } from './http-stream';

/** App boundary binds the host once; business services cannot choose a transport. */
export function consumeAppSse(
  url: string,
  options: {
    signal: AbortSignal;
    onResponse?: (response: Response) => void;
    onOpen?: () => void;
    onFrame: (frame: SseFrame) => void;
  },
): Promise<void> {
  return consumeSse(url, { ...options, transport: appHttpStream });
}
