import { ConfigService } from '@nestjs/config';
import { MemberEmailService } from './member-email.service.js';

const create = (values: Record<string, string | undefined> = {}) =>
  new MemberEmailService(new ConfigService(values));
afterEach(() => vi.unstubAllGlobals());

it('requires an explicitly configured delivery mode and rejects console outside local development', () => {
  expect(() => create().mode('127.0.0.1')).toThrow(/non configuré/);
  expect(
    create({ MEMBER_EMAIL_MODE: 'console', NODE_ENV: 'development' }).mode(
      '127.0.0.1',
    ),
  ).toBe('console');
  for (const values of [
    { MEMBER_EMAIL_MODE: 'console', NODE_ENV: 'production' },
    {
      MEMBER_EMAIL_MODE: 'console',
      CHECKOUT_SITE_URL: 'https://connecta.example',
    },
  ])
    expect(() => create(values).mode('127.0.0.1')).toThrow(
      /développement local/,
    );
  expect(() =>
    create({ MEMBER_EMAIL_MODE: 'console' }).mode('203.0.113.1'),
  ).toThrow(/développement local/);
});

it('sends the login link with the server-side email key and translates provider failures', async () => {
  const service = create({
    RESEND_API_KEY: 're_test_private',
    MEMBER_EMAIL_FROM: 'CONNECTA <login@example.com>',
  });
  expect(service.mode('203.0.113.1')).toBe('email');
  const send = vi.fn(
    async (_url: string, _options: RequestInit) =>
      new Response(JSON.stringify({ id: 'fixture' }), { status: 200 }),
  );
  vi.stubGlobal('fetch', send);
  await service.send(
    'customer@example.com',
    'https://connecta.example/compte#connexion=fixture',
    'email',
  );
  expect(send.mock.calls[0]).toMatchObject([
    'https://api.resend.com/emails',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer re_test_private' },
    },
  ]);
  const options = send.mock.calls[0][1] as RequestInit;
  expect(JSON.parse(String(options.body))).toMatchObject({
    to: ['customer@example.com'],
    subject: 'Votre connexion à CONNECTA',
  });
  send.mockResolvedValueOnce(new Response('', { status: 429 }));
  await expect(
    service.send(
      'customer@example.com',
      'https://connecta.example/compte',
      'email',
    ),
  ).rejects.toMatchObject({ status: 503 });
});
