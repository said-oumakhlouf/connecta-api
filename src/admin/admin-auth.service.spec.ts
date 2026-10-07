import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { AdminAuthService } from './admin-auth.service.js';

const password = 'test-only-admin-password-123';
const status = (call: () => unknown) => {
  try {
    call();
  } catch (error) {
    return (error as HttpException).getStatus();
  }
  throw new Error('Expected rejection');
};

describe('Admin sessions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requires a configured password of at least 16 characters', () => {
    for (const value of [undefined, '', 'short']) {
      const auth = new AdminAuthService(
        new ConfigService({ ADMIN_PASSWORD: value }),
      );
      expect(status(() => auth.login(password, 'ip'))).toBe(503);
    }
  });

  it('issues an opaque token and rejects a fabricated token', () => {
    const auth = new AdminAuthService(
      new ConfigService({ ADMIN_PASSWORD: password }),
    );
    const session = auth.login(password, 'ip');
    expect(session.token).toMatch(/^[a-f0-9]{64}$/);
    expect(auth.authorize(`Bearer ${session.token}`)).toBe(session.token);
    expect(status(() => auth.authorize(`Bearer ${'a'.repeat(64)}`))).toBe(401);
    expect(status(() => auth.authorize())).toBe(401);
  });

  it('revokes a token on logout', () => {
    const auth = new AdminAuthService(
      new ConfigService({ ADMIN_PASSWORD: password }),
    );
    const session = auth.login(password, 'ip');
    auth.logout(`Bearer ${session.token}`);
    expect(status(() => auth.authorize(`Bearer ${session.token}`))).toBe(401);
  });

  it('expires sessions after eight hours', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const auth = new AdminAuthService(
      new ConfigService({ ADMIN_PASSWORD: password }),
    );
    const session = auth.login(password, 'ip');
    clock.mockReturnValue(1000 + 8 * 60 * 60 * 1000);
    expect(status(() => auth.authorize(`Bearer ${session.token}`))).toBe(401);
  });

  it('limits failed login attempts by address and resets after fifteen minutes', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const auth = new AdminAuthService(
      new ConfigService({ ADMIN_PASSWORD: password }),
    );
    for (let i = 0; i < 5; i++)
      expect(status(() => auth.login('wrong', 'ip'))).toBe(401);
    expect(status(() => auth.login(password, 'ip'))).toBe(429);
    expect(auth.login(password, 'other-ip').token).toHaveLength(64);
    clock.mockReturnValue(1000 + 15 * 60 * 1000);
    expect(auth.login(password, 'ip').token).toHaveLength(64);
  });
});
