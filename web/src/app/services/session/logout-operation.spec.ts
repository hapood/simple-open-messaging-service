import { completeLogout, type LogoutOperation } from './logout-operation';

function setup() {
  const operation = {
    stopWork: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue({ status: 'revoked' }),
    decide: vi.fn().mockResolvedValue('localOnly'),
    finalize: vi.fn().mockResolvedValue(undefined),
  } satisfies LogoutOperation;
  return operation;
}

describe('logout operation ordering', () => {
  it('stops work before revocation and finalizes only after confirmation', async () => {
    const operation = setup();
    const order: string[] = [];
    operation.stopWork.mockImplementation(async () => { order.push('stop'); });
    operation.revoke.mockImplementation(async () => { order.push('revoke'); return { status: 'revoked' }; });
    operation.finalize.mockImplementation(async () => { order.push('finalize'); });
    expect(await completeLogout(operation)).toBe('revoked');
    expect(order).toEqual(['stop', 'revoke', 'finalize']);
    expect(operation.decide).not.toHaveBeenCalled();
  });

  it('retains resources until the user explicitly chooses local-only logout', async () => {
    const operation = setup();
    operation.revoke.mockResolvedValue({ status: 'timedOut' });
    let choose!: (value: 'localOnly') => void;
    operation.decide.mockImplementation(() => new Promise((resolve) => { choose = resolve; }));
    const pending = completeLogout(operation);
    await vi.waitFor(() => expect(operation.decide).toHaveBeenCalledOnce());
    expect(operation.finalize).not.toHaveBeenCalled();
    expect(operation.revoke).toHaveBeenCalledOnce();
    choose('localOnly');
    expect(await pending).toBe('localOnly');
    expect(operation.finalize).toHaveBeenCalledWith('localOnly');
  });

  it('retries only after an explicit decision', async () => {
    const operation = setup();
    operation.revoke.mockResolvedValueOnce({ status: 'httpFailure', status_code: 503 });
    operation.decide.mockResolvedValue('retry');
    expect(await completeLogout(operation)).toBe('revoked');
    expect(operation.stopWork).toHaveBeenCalledOnce();
    expect(operation.revoke).toHaveBeenCalledTimes(2);
    expect(operation.finalize).toHaveBeenCalledOnce();
  });

  it('surfaces cleanup failure instead of reporting completed logout', async () => {
    const operation = setup();
    operation.finalize.mockRejectedValue(new Error('secure storage locked'));
    await expect(completeLogout(operation)).rejects.toThrow('secure storage locked');
  });
});
