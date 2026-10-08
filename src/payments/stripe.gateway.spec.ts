import { ConfigService } from '@nestjs/config';
import { StripeGateway } from './stripe.gateway.js';

describe('Stripe test configuration', () => {
  it('disables checkout without keys or with a live key', () => {
    for (const STRIPE_SECRET_KEY of ['', 'sk_live_not_allowed']) {
      const gateway = new StripeGateway(
        new ConfigService({
          STRIPE_SECRET_KEY,
          STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
        }),
      );
      expect(() => gateway.requireClient()).toThrow();
    }
  });
  it('requires a webhook secret even with a test key', () => {
    expect(() =>
      new StripeGateway(
        new ConfigService({ STRIPE_SECRET_KEY: 'sk_test_fixture' }),
      ).requireClient(),
    ).toThrow();
  });
  it('rejects origins that could leak checkout return identifiers', () => {
    for (const CHECKOUT_SITE_URL of [
      'https://user:pass@example.com',
      'https://example.com?other=1',
      'https://example.com/path',
    ]) {
      expect(
        () => new StripeGateway(new ConfigService({ CHECKOUT_SITE_URL })),
      ).toThrow();
    }
  });
});
