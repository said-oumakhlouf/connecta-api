import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

@Injectable()
export class StripeGateway {
  readonly client: Stripe | null;
  readonly origin: string;
  private readonly secret: string;

  constructor(config: ConfigService) {
    const key = config.get<string>('STRIPE_SECRET_KEY') ?? '';
    this.secret = config.get<string>('STRIPE_WEBHOOK_SECRET') ?? '';
    this.origin =
      config.get<string>('CHECKOUT_SITE_URL') ?? 'http://localhost:3000';
    // This first integration deliberately cannot create real charges.
    this.client =
      key.startsWith('sk_test_') && this.secret.startsWith('whsec_')
        ? new Stripe(key, { timeout: 10000, maxNetworkRetries: 1 })
        : null;
    const url = new URL(this.origin);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !['http:', 'https:'].includes(url.protocol)
    ) {
      throw new Error(
        'CHECKOUT_SITE_URL doit être une origine HTTP(S) sans chemin',
      );
    }
  }

  requireClient() {
    if (!this.client)
      throw new ServiceUnavailableException(
        'Configurez les clés Stripe de test et le webhook',
      );
    return this.client;
  }

  verify(body: Buffer, signature: string) {
    return this.requireClient().webhooks.constructEvent(
      body,
      signature,
      this.secret,
    );
  }
}
