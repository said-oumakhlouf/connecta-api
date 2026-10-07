import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const SESSION_DURATION = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW = 15 * 60 * 1000;
const digest = (value: string) => createHash('sha256').update(value).digest();

@Injectable()
export class AdminAuthService {
  private readonly sessions = new Map<string, number>();
  private readonly attempts = new Map<
    string,
    { count: number; until: number }
  >();

  constructor(private readonly config: ConfigService) {}

  login(password: string, address: string) {
    const configured = this.config.get<string>('ADMIN_PASSWORD');
    if (
      !configured ||
      configured.trim().length < 16 ||
      configured.length > 256
    ) {
      throw new ServiceUnavailableException(
        'Accès administrateur non configuré',
      );
    }
    const now = Date.now();
    this.prune(now);
    const attempt = this.attempts.get(address);
    if (attempt && attempt.count >= 5) {
      throw new HttpException(
        'Réessayez dans 15 minutes',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!timingSafeEqual(digest(password), digest(configured))) {
      if (this.attempts.size >= 5000 && !attempt) {
        throw new HttpException(
          'Réessayez plus tard',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      this.attempts.set(address, {
        count: (attempt?.count ?? 0) + 1,
        until: attempt?.until ?? now + LOGIN_WINDOW,
      });
      throw new UnauthorizedException('Mot de passe incorrect');
    }
    this.attempts.delete(address);
    if (this.sessions.size >= 100) {
      throw new HttpException(
        'Trop de sessions actives',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const token = randomBytes(32).toString('hex');
    const expiresAt = now + SESSION_DURATION;
    this.sessions.set(digest(token).toString('hex'), expiresAt);
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  authorize(authorization?: string): string {
    this.prune(Date.now());
    const token = /^Bearer ([a-f0-9]{64})$/.exec(authorization ?? '')?.[1];
    if (!token || !this.sessions.has(digest(token).toString('hex'))) {
      throw new UnauthorizedException(
        'Session administrateur expirée ou absente',
      );
    }
    return token;
  }

  logout(authorization?: string) {
    const token = this.authorize(authorization);
    this.sessions.delete(digest(token).toString('hex'));
  }

  private prune(now: number) {
    for (const [key, expiry] of this.sessions) {
      if (expiry <= now) this.sessions.delete(key);
    }
    for (const [key, attempt] of this.attempts) {
      if (attempt.until <= now) this.attempts.delete(key);
    }
  }
}
