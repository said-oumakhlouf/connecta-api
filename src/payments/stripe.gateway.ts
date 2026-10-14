import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

/** Parse an exact HTTP(S) origin (no path, query, hash or credentials). */
function parseOrigin(value: string, variable: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} doit contenir des origines HTTP(S) sans chemin`);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !['http:', 'https:'].includes(url.protocol)
  ) {
    throw new Error(`${variable} doit contenir des origines HTTP(S) sans chemin`);
  }
  return url.origin;
}

@Injectable()
export class StripeGateway {
  readonly client: Stripe | null;
  readonly origin: string;
  /** Storefront origins that may receive the shopper back from payment. */
  readonly returnOrigins: ReadonlySet<string>;
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
    const defaultOrigin = parseOrigin(this.origin, 'CHECKOUT_SITE_URL');
    // Optional, explicit allowlist (e.g. localhost + a Tailscale host in development).
    // Unset: every return goes to CHECKOUT_SITE_URL exactly as before.
    const extra = (config.get<string>('CHECKOUT_RETURN_ORIGINS') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => parseOrigin(value, 'CHECKOUT_RETURN_ORIGINS'));
    this.returnOrigins = new Set([defaultOrigin, ...extra]);
  }

  /**
   * Origin used to build Stripe return URLs. The request Origin header only
   * selects among explicitly allowed origins; anything else falls back to
   * CHECKOUT_SITE_URL, so a forged header can never redirect elsewhere.
   */
  returnOrigin(requestOrigin?: string) {
    const fallback = new URL(this.origin).origin;
    if (!requestOrigin || requestOrigin.length > 2048) return fallback;
    try {
      const candidate = new URL(requestOrigin);
      return candidate.origin === requestOrigin &&
        this.returnOrigins.has(candidate.origin)
        ? candidate.origin
        : fallback;
    } catch {
      return fallback;
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
