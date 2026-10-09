import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MemberEmailService {
  private readonly logger = new Logger(MemberEmailService.name);
  constructor(private readonly config: ConfigService) {}

  mode(ip: string): 'console' | 'email' {
    const mode = this.config.get<string>('MEMBER_EMAIL_MODE') ?? 'resend';
    if (mode === 'console') {
      const origin = new URL(
        this.config.get<string>('CHECKOUT_SITE_URL') ?? 'http://localhost:3000',
      );
      if (
        this.config.get<string>('NODE_ENV') === 'production' ||
        !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
        !['::1', '127.0.0.1', '::ffff:127.0.0.1'].includes(ip)
      ) {
        throw new ServiceUnavailableException(
          'Le mode console est réservé au développement local.',
        );
      }
      return 'console';
    }
    if (
      mode !== 'resend' ||
      !this.config.get<string>('RESEND_API_KEY') ||
      !this.config.get<string>('MEMBER_EMAIL_FROM')
    )
      throw new ServiceUnavailableException(
        'Envoi des emails membres non configuré.',
      );
    return 'email';
  }

  async send(email: string, url: string, mode: 'console' | 'email') {
    if (mode === 'console') {
      this.logger.log(`Lien membre — test local uniquement : ${url}`);
      return;
    }
    try {
      const result = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.getOrThrow<string>('RESEND_API_KEY')}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          from: this.config.getOrThrow<string>('MEMBER_EMAIL_FROM'),
          to: [email],
          subject: 'Votre connexion à CONNECTA',
          text: `Pour accéder à votre espace membre CONNECTA, ouvrez ce lien :\n${url}\n\nCe lien est valable 15 minutes et utilisable une seule fois. Si vous n’avez pas demandé cette connexion, ignorez cet email.`,
        }),
      });
      if (!result.ok) throw new Error('Email rejected');
    } catch {
      throw new ServiceUnavailableException(
        'Envoi du lien indisponible. Réessayez plus tard.',
      );
    }
  }
}
