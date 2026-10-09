import { createHash, randomBytes } from 'node:crypto';
import {
  ForbiddenException,
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemberEmailService } from './member-email.service.js';

export const MEMBER_COOKIE = 'connecta_member';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const DURATION = 8 * 60 * 60 * 1000;

@Injectable()
export class MemberAuthService {
  private readonly attempts = new Map<
    string,
    { count: number; until: number }
  >();
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly email: MemberEmailService,
  ) {}

  assertOrigin(origin?: string) {
    const allowed = (
      this.config.get<string>('CORS_ORIGINS') ??
      'http://localhost:3000,http://127.0.0.1:3000'
    )
      .split(',')
      .map((value) => value.trim());
    if (!origin || !allowed.includes(origin))
      throw new ForbiddenException('Origine de la demande refusée.');
  }

  private limit(key: string, maximum: number) {
    const now = Date.now();
    for (const [address, value] of this.attempts)
      if (value.until <= now) this.attempts.delete(address);
    const value = this.attempts.get(key) ?? {
      count: 0,
      until: now + 15 * 60 * 1000,
    };
    if (
      value.count >= maximum ||
      (!this.attempts.has(key) && this.attempts.size >= 5000)
    )
      throw new HttpException(
        'Trop de demandes de connexion. Patientez 15 minutes.',
        429,
      );
    value.count++;
    this.attempts.set(key, value);
  }

  async requestLink(email: string, ip: string) {
    this.limit(`request:${ip}`, 5);
    const mode = this.email.mode(ip);
    const normalized = email.trim().toLowerCase();
    const recent = await this.prisma.memberLoginToken.count({
      where: {
        email: normalized,
        createdAt: { gte: new Date(Date.now() - 15 * 60 * 1000) },
      },
    });
    if (recent >= 3)
      throw new HttpException(
        'Trop de demandes de connexion. Patientez 15 minutes.',
        429,
      );
    const token = randomBytes(32).toString('hex');
    const tokenHash = hash(token);
    await this.prisma.memberLoginToken.create({
      data: {
        tokenHash,
        email: normalized,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
    const origin = new URL(
      this.config.get<string>('CHECKOUT_SITE_URL') ?? 'http://localhost:3000',
    );
    const url = new URL('/compte', origin);
    // A fragment is not sent to the web server or included in referrer URLs.
    url.hash = `connexion=${token}`;
    try {
      await this.email.send(normalized, url.toString(), mode);
    } catch (error) {
      await this.prisma.memberLoginToken.deleteMany({ where: { tokenHash } });
      throw error;
    }
    return { accepted: true, delivery: mode };
  }

  async verify(token: string, ip: string) {
    this.limit(`verify:${ip}`, 20);
    const sessionToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + DURATION);
    const member = await this.prisma.$transaction(async (tx) => {
      const tokenHash = hash(token);
      const changed = await tx.memberLoginToken.updateMany({
        where: { tokenHash, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (!changed.count)
        throw new UnauthorizedException(
          'Lien expiré ou déjà utilisé. Demandez un nouveau lien.',
        );
      const login = await tx.memberLoginToken.findUniqueOrThrow({
        where: { tokenHash },
      });
      const member = await tx.member.upsert({
        where: { email: login.email },
        create: { email: login.email },
        update: {},
      });
      await tx.memberSession.create({
        data: { tokenHash: hash(sessionToken), memberId: member.id, expiresAt },
      });
      return member;
    });
    return {
      token: sessionToken,
      profile: { email: member.email, expiresAt: expiresAt.toISOString() },
    };
  }

  token(request: Request) {
    const values = (request.headers.cookie ?? '')
      .split(';')
      .map((value) => value.trim());
    const token = values
      .find((value) => value.startsWith(`${MEMBER_COOKIE}=`))
      ?.slice(MEMBER_COOKIE.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token))
      throw new UnauthorizedException('Connectez-vous à votre espace membre.');
    return token;
  }

  async authorize(request: Request) {
    const session = await this.prisma.memberSession.findUnique({
      where: { tokenHash: hash(this.token(request)) },
      include: { member: true },
    });
    if (!session || session.expiresAt.getTime() <= Date.now())
      throw new UnauthorizedException('Session expirée. Reconnectez-vous.');
    return {
      email: session.member.email,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  async logout(request: Request) {
    await this.prisma.memberSession.deleteMany({
      where: { tokenHash: hash(this.token(request)) },
    });
  }

  cookieOptions() {
    return {
      httpOnly: true,
      secure:
        this.config.get<string>('NODE_ENV') === 'production' ||
        (this.config.get<string>('CHECKOUT_SITE_URL') ?? '').startsWith(
          'https:',
        ),
      sameSite: 'lax' as const,
      path: '/members',
      maxAge: DURATION,
    };
  }
}
