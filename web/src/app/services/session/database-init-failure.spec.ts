import { DatabaseRestorationError } from './database-restoration-error';
import { classifyDatabaseInitFailure } from './database-init-failure';

describe('database initialization failure classification', () => {
  it('classifies permission, busy storage, and structural damage', () => {
    expect(
      classifyDatabaseInitFailure(
        Object.assign(new Error('blocked'), { name: 'SecurityError' }),
      ),
    ).toBe('permission');
    expect(
      classifyDatabaseInitFailure(
        Object.assign(new Error('full'), { name: 'QuotaExceededError' }),
      ),
    ).toBe('busy');
    expect(
      classifyDatabaseInitFailure(
        new DatabaseRestorationError(new Error('missing cache')),
      ),
    ).toBe('structural');
    expect(
      classifyDatabaseInitFailure('SESSION_DATABASE_ERROR:invalid schema'),
    ).toBe('structural');
  });

  it('does not treat network or credential failures as a restoration choice', () => {
    expect(classifyDatabaseInitFailure(new Error('HELLO timed out'))).toBeNull();
    expect(classifyDatabaseInitFailure(new Error('401'))).toBeNull();
  });
});
