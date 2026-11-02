import { microphoneStream } from './microphone-stream';

describe('microphone acquisition ownership', () => {
  it('releases a late grant without delivering it to an ended recording', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let grant!: (stream: MediaStream) => void;
      const acquired = new Promise<MediaStream>((resolve) => {
        grant = resolve;
      });
      const next = vi.fn();
      const stop = vi.fn();
      const subscription = microphoneStream(() => acquired).subscribe(next);
      subscription.unsubscribe();
      subscription.unsubscribe();
      expect(warn).toHaveBeenCalledOnce();
      grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
      await Promise.resolve();
      expect(next).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not deliver a late permission denial', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let deny!: (error: Error) => void;
      const acquired = new Promise<MediaStream>((_, reject) => {
        deny = reject;
      });
      const error = vi.fn();
      const subscription = microphoneStream(() => acquired).subscribe({
        error,
      });
      subscription.unsubscribe();
      deny(new Error('permission denied'));
      await Promise.resolve();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('synchronously releases an acquired microphone exactly once', async () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    const next = vi.fn();
    const subscription = microphoneStream(() =>
      Promise.resolve(stream),
    ).subscribe(next);
    await Promise.resolve();
    expect(next).toHaveBeenCalledWith(stream);
    expect(stop).not.toHaveBeenCalled();
    subscription.unsubscribe();
    expect(stop).toHaveBeenCalledOnce();
    subscription.unsubscribe();
    expect(stop).toHaveBeenCalledOnce();
  });
});
