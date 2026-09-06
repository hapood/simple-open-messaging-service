/** A scoped SSE subscription, opened before requesting lazy profiles. */
export async function openProfileEvents(actor, timeoutMs, fetchImpl = fetch) {
  const abort = new AbortController();
  const openingTimer = setTimeout(() => abort.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${actor.node.backendBaseUrl}/api/v1/events`, {
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${actor.token}`,
      },
      signal: abort.signal,
    });
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get('content-type')?.includes('text/event-stream')
    ) {
      throw new Error(
        `${actor.address}: profile SSE returned HTTP ${response.status} without an event stream`,
      );
    }
  } catch (error) {
    abort.abort();
    throw error;
  } finally {
    clearTimeout(openingTimer);
  }
  const reader = response.body.getReader();
  const results = new Map();
  const waiters = new Map();
  let failure;
  const fail = (error) => {
    failure = error;
    for (const waiter of waiters.values()) waiter.reject(error);
    waiters.clear();
  };
  const consume = (frame) => {
    const lines = frame.split('\n');
    const event = lines
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim();
    if (event !== 'PROFILE_RESOLVED' && event !== 'PROFILE_FAILED') return;
    const data = JSON.parse(
      lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n'),
    );
    if (typeof data.requestId !== 'string')
      throw new Error('profile SSE has no requestId');
    const result = { ...data, event };
    const waiter = waiters.get(data.requestId);
    if (waiter) {
      waiters.delete(data.requestId);
      waiter.resolve(result);
    } else {
      // An event may arrive before the initiating HTTP response is received.
      results.set(data.requestId, result);
      if (results.size > 1000) results.delete(results.keys().next().value);
    }
  };
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`${actor.address}: profile SSE disconnected`);
      buffer += decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        consume(buffer.slice(0, match.index).replaceAll('\r\n', '\n'));
        buffer = buffer.slice(match.index + match[0].length);
      }
      if (buffer.length > 1024 * 1024)
        throw new Error('profile SSE frame exceeds limit');
    }
  })().catch(fail);
  return {
    wait(requestId, waitMs = timeoutMs) {
      if (results.has(requestId)) {
        const result = results.get(requestId);
        results.delete(requestId);
        return Promise.resolve(result);
      }
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(requestId);
          reject(
            new Error(
              `${actor.address}: timed out waiting for profile SSE requestId=${requestId}`,
            ),
          );
        }, waitMs);
        waiters.set(requestId, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
    },
    async close() {
      fail(new Error(`${actor.address}: profile SSE closed`));
      abort.abort();
      await reader.cancel().catch(() => {});
      await reading;
      results.clear();
    },
  };
}
