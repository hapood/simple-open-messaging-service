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
  const results = [];
  const waiters = [];
  let failure;
  const fail = (error) => {
    failure = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };
  const consume = (frame) => {
    const lines = frame.split('\n');
    const event = lines
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim();
    if (event !== 'PROFILE_AVAILABLE' && event !== 'PROFILE_UNAVAILABLE')
      return;
    const data = JSON.parse(
      lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n'),
    );
    const key = data;
    if (
      !Number.isSafeInteger(key?.namespaceId) ||
      typeof key?.account !== 'string' ||
      typeof key?.domain !== 'string' ||
      !Number.isSafeInteger(key?.rev)
    )
      throw new Error('profile SSE has no profile key');
    const result = { event, key, reason: data.reason };
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(result);
    else {
      results.push(result);
      if (results.length > 1000) results.shift();
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
    wait(waitMs = timeoutMs) {
      if (results.length) return Promise.resolve(results.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(
            new Error(`${actor.address}: timed out waiting for profile SSE`),
          );
        }, waitMs);
        waiters.push(waiter);
      });
    },
    async close() {
      fail(new Error(`${actor.address}: profile SSE closed`));
      abort.abort();
      await reader.cancel().catch(() => {});
      await reading;
      results.length = 0;
    },
  };
}
