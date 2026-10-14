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
  it('rejects invalid extra return origins at startup', () => {
    for (const CHECKOUT_RETURN_ORIGINS of [
      'http://localhost:3000,https://evil.example/path',
      'javascript:alert(1)',
      'https://user:pass@example.com',
    ]) {
      expect(
        () => new StripeGateway(new ConfigService({ CHECKOUT_RETURN_ORIGINS })),
      ).toThrow();
    }
  });
  it('returns only to explicitly allowed origins, never to an arbitrary Origin header', () => {
    const gateway = new StripeGateway(
      new ConfigService({
        CHECKOUT_SITE_URL: 'https://shop.example.ts.net',
        CHECKOUT_RETURN_ORIGINS: ' http://localhost:3000 , http://127.0.0.1:3000/ ',
      }),
    );
    expect(gateway.returnOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(gateway.returnOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(gateway.returnOrigin('https://shop.example.ts.net')).toBe('https://shop.example.ts.net');
    for (const forged of [
      undefined,
      '',
      'null',
      'https://evil.example',
      'http://localhost:3001',
      'http://localhost:3000/',
      'http://localhost:3000.evil.example',
      'http://LOCALHOST:3000',
    ])
      expect(gateway.returnOrigin(forged)).toBe('https://shop.example.ts.net');
  });
  it('keeps the single CHECKOUT_SITE_URL return when no extra origin is configured', () => {
    const gateway = new StripeGateway(
      new ConfigService({ CHECKOUT_SITE_URL: 'https://connecta.example/' }),
    );
    expect([...gateway.returnOrigins]).toEqual(['https://connecta.example']);
    expect(gateway.returnOrigin('http://localhost:3000')).toBe('https://connecta.example');
  });
});
