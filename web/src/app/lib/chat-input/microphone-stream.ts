import { Observable } from 'rxjs';

/** Own microphone acquisition and tracks until unsubscribe. The browser cannot
 * dismiss a pending permission prompt: a late stream is released here, never
 * delivered to the former recorder. */
export function microphoneStream(
  acquire: () => Promise<MediaStream> = () =>
    navigator.mediaDevices.getUserMedia({ audio: true }),
): Observable<MediaStream> {
  return new Observable((subscriber) => {
    let pending = true;
    let stream: MediaStream | undefined;
    void acquire().then(
      (value) => {
        pending = false;
        if (subscriber.closed) {
          value.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = value;
        subscriber.next(value);
      },
      (error: unknown) => {
        pending = false;
        subscriber.error(error);
      },
    );
    return () => {
      if (pending)
        console.warn(
          '[recording] Ended while microphone permission is pending; the browser cannot cancel the prompt. Any late stream will be released.',
        );
      stream?.getTracks().forEach((track) => track.stop());
      stream = undefined;
    };
  });
}
