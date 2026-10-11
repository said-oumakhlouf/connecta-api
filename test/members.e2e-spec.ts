import { createHash, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import Stripe from 'stripe';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import { StripeGateway } from '../src/payments/stripe.gateway.js';
import { MemberEmailService } from '../src/members/member-email.service.js';
import { MemberAuthService } from '../src/members/member-auth.service.js';
import { configureCors } from '../src/configure-cors.js';
import { OrdersService } from '../src/orders/orders.service.js';

const origin = 'http://localhost:3000';
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
describe.skipIf(!process.env.TEST_DATABASE_URL)('Member accounts (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let productId: number;
  let email: string;
  let addresses: Set<string>;
  let mail: { mode: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
  let sessions: Map<string, Stripe.Checkout.Session>;
  let config: ConfigService;

  beforeEach(async () => {
    addresses = new Set();
    email = `${randomUUID()}@example.com`;
    addresses.add(email);
    mail = { mode: vi.fn(() => 'email'), send: vi.fn(async () => undefined) };
    sessions = new Map();
    const sdk = {
      checkout: {
        sessions: {
          create: async (params: Stripe.Checkout.SessionCreateParams) => {
            const id = `cs_test_${randomUUID().replaceAll('-', '')}`;
            const session = {
              id,
              livemode: false,
              mode: 'payment',
              currency: 'eur',
              metadata: params.metadata,
              client_reference_id: params.client_reference_id,
              amount_total: params.line_items!.reduce(
                (sum, item) => sum + Number(item.price_data!.unit_amount),
                0,
              ),
              status: 'open',
              payment_status: 'unpaid',
              expires_at: params.expires_at,
              url: `https://checkout.stripe.com/c/pay/${id}`,
            } as Stripe.Checkout.Session;
            sessions.set(id, session);
            return session;
          },
          retrieve: async (id: string) => ({ ...sessions.get(id)! }),
          expire: async (id: string) => {
            const session = sessions.get(id)!;
            session.status = 'expired';
            return { ...session };
          },
        },
      },
    };
    config = new ConfigService({
      NODE_ENV: 'test',
      SHIPPING_FR_CENTS: '0',
      CORS_ORIGINS: origin,
      CHECKOUT_SITE_URL: origin,
    });
    prisma = new PrismaService(
      new ConfigService({ DATABASE_URL: process.env.TEST_DATABASE_URL }),
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(MemberEmailService)
      .useValue(mail)
      .overrideProvider(StripeGateway)
      .useValue({ client: sdk, origin, requireClient: () => sdk })
      .compile();
    app = module.createNestApplication({ rawBody: true });
    configureCors(app, origin);
    await app.init();
    productId = (
      await prisma.product.create({
        data: {
          name: 'Member product',
          slug: randomUUID(),
          price: 3500,
          duoPrice: 6000,
          stock: 20,
        },
      })
    ).id;
  });
  afterEach(async () => {
    await prisma.order.deleteMany({
      where: { items: { some: { productId } } },
    });
    await prisma.member.deleteMany({
      where: { email: { in: [...addresses] } },
    });
    await prisma.memberLoginToken.deleteMany({
      where: { email: { in: [...addresses] } },
    });
    await prisma.product.delete({ where: { id: productId } });
    await app.close();
  });
  const link = async (address = email) => {
    addresses.add(address.trim().toLowerCase());
    const result = await request(app.getHttpServer())
      .post('/members/login')
      .set('Origin', origin)
      .send({ email: address })
      .expect(200);
    expect(result.body).toEqual({ accepted: true, delivery: 'email' });
    const url = new URL(mail.send.mock.calls.at(-1)![1]);
    return new URLSearchParams(url.hash.slice(1)).get('connexion')!;
  };
  const verify = (token: string) =>
    request(app.getHttpServer())
      .post('/members/verify')
      .set('Origin', origin)
      .send({ token });
  const login = async (address = email) => {
    const response = await verify(await link(address)).expect(200);
    return response.headers['set-cookie'][0].split(';')[0] as string;
  };
  const order = async (address = email) => {
    const result = await app.get(PaymentsService).checkout(
      {
        customerName: 'Member customer',
        customerEmail: address,
        items: [{ productId, quantity: 2 }],
        shippingAddress: { country: 'FR', line1: '12 rue du Test', line2: '', city: 'Paris', postalCode: '75001', region: '' },
        expectedShippingFee: 0,
        checkoutKey: randomUUID(),
      },
      '203.0.113.1',
    );
    const record = await prisma.order.findFirstOrThrow({
      where: { checkoutSessionId: result.sessionId },
    });
    return { ...record, session: sessions.get(result.sessionId)! };
  };
  const stock = async () =>
    (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
      .stock;

  it('does not reveal orders without a session and supports credentialed CORS only for allowed origins', async () => {
    await request(app.getHttpServer()).get('/members/me').expect(401);
    await request(app.getHttpServer()).get('/members/orders').expect(401);
    const preflight = await request(app.getHttpServer())
      .options('/members/verify')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
      .expect(204);
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');
    expect(preflight.headers['access-control-allow-origin']).toBe(origin);
    await request(app.getHttpServer())
      .post('/members/login')
      .set('Origin', 'https://evil.test')
      .send({ email })
      .expect(403);
    await request(app.getHttpServer())
      .post('/members/login')
      .set('Origin', origin)
      .send({ email, admin: true })
      .expect(400);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('verifies email once, stores only token hashes and restores the session after service restart', async () => {
    const token = await link(` ${email.toUpperCase()} `);
    expect(await prisma.member.count({ where: { email } })).toBe(0);
    expect(
      await prisma.memberLoginToken.findUnique({ where: { tokenHash: token } }),
    ).toBeNull();
    expect(
      await prisma.memberLoginToken.findUnique({
        where: { tokenHash: digest(token) },
      }),
    ).not.toBeNull();
    await request(app.getHttpServer())
      .get(`/members/verify?token=${token}`)
      .expect(404);
    const response = await verify(token).expect(200);
    expect(response.body.email).toBe(email);
    expect(response.body.token).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    const cookie = response.headers['set-cookie'][0];
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/members');
    const value = cookie.split(';')[0];
    const sessionToken = value.split('=')[1];
    expect(
      await prisma.memberSession.findUnique({
        where: { tokenHash: sessionToken },
      }),
    ).toBeNull();
    expect(
      await prisma.memberSession.findUnique({
        where: { tokenHash: digest(sessionToken) },
      }),
    ).not.toBeNull();
    await verify(token).expect(401);
    const restarted = new MemberAuthService(
      prisma,
      config,
      mail as unknown as MemberEmailService,
    );
    expect(
      (await restarted.authorize({ headers: { cookie: value } } as Request))
        .email,
    ).toBe(email);
    await request(app.getHttpServer())
      .post('/members/logout')
      .set('Cookie', value)
      .set('Origin', 'https://evil.test')
      .expect(403);
    await request(app.getHttpServer())
      .post('/members/logout')
      .set('Cookie', value)
      .set('Origin', origin)
      .expect(204);
    await request(app.getHttpServer())
      .get('/members/me')
      .set('Cookie', value)
      .expect(401);
  });

  it('refuses expired links and expired sessions without creating a member for an expired link', async () => {
    const token = await link();
    await prisma.memberLoginToken.update({
      where: { tokenHash: digest(token) },
      data: { expiresAt: new Date(0) },
    });
    await verify(token).expect(401);
    expect(await prisma.member.count({ where: { email } })).toBe(0);
    const cookie = await login();
    await prisma.memberSession.updateMany({
      where: { member: { email } },
      data: { expiresAt: new Date(0) },
    });
    await request(app.getHttpServer())
      .get('/members/orders')
      .set('Cookie', cookie)
      .expect(401);
  });

  it('limits repeated link requests and invalidates a token when delivery fails', async () => {
    mail.send.mockRejectedValueOnce(new Error('Delivery unavailable'));
    await request(app.getHttpServer())
      .post('/members/login')
      .set('Origin', origin)
      .send({ email })
      .expect(500);
    expect(await prisma.memberLoginToken.count({ where: { email } })).toBe(0);
    for (let index = 0; index < 3; index++) await link();
    await request(app.getHttpServer())
      .post('/members/login')
      .set('Origin', origin)
      .send({ email })
      .expect(429);
  });

  it('prefills only the verified member and refuses another email at checkout', async () => {
    const mine = await order();
    await order(`other-${email}`);
    mine.session.status = 'complete';
    mine.session.payment_status = 'paid';
    await app.get(PaymentsService).applySession(mine.session, mine);
    const cookie = await login();

    const own = await request(app.getHttpServer())
      .get('/members/me')
      .set('Cookie', cookie)
      .expect(200);
    expect(own.body).toMatchObject({
      email,
      customerName: 'Member customer',
      shippingAddress: mine.shippingAddress,
    });
    expect(JSON.stringify(own.body)).not.toContain('other-');

    const dto = {
      customerName: 'Member customer',
      customerEmail: email,
      items: [{ productId, quantity: 1 }],
      shippingAddress: { country: 'FR', line1: '12 rue du Test', line2: '', city: 'Paris', postalCode: '75001', region: '' },
      expectedShippingFee: 0,
      checkoutKey: randomUUID(),
    };
    await request(app.getHttpServer())
      .post('/members/checkout')
      .set('Origin', origin)
      .send(dto)
      .expect(401);
    await request(app.getHttpServer())
      .post('/members/checkout')
      .set('Origin', 'https://evil.test')
      .set('Cookie', cookie)
      .send(dto)
      .expect(403);
    await request(app.getHttpServer())
      .post('/members/checkout')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ ...dto, customerEmail: `other-${email}` })
      .expect(403);
    const response = await request(app.getHttpServer())
      .post('/members/checkout')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send(dto)
      .expect(200);
    expect(response.body.total).toBe(3500);
    const created = await prisma.order.findUniqueOrThrow({ where: { checkoutKey: dto.checkoutKey } });
    expect(created.customerEmail).toBe(email);
    expect(created.customerName).toBe('Member customer');
  });

  it('shows the shipment tracking to its verified owner', async () => {
    const mine = await order();
    mine.session.status = 'complete'; mine.session.payment_status = 'paid';
    await app.get(PaymentsService).applySession(mine.session, mine);
    const { AdminService } = await import('../src/admin/admin.service.js');
    await app.get(AdminService).updateFulfillment(mine.id, { status: 'PREPARING' });
    await app.get(AdminService).updateFulfillment(mine.id, { status: 'SHIPPED', trackingCarrier: 'Colissimo', trackingNumber: 'TEST123456' });
    const cookie = await login();
    const response = await request(app.getHttpServer()).get('/members/orders').set('Cookie', cookie).expect(200);
    expect(response.body.orders[0]).toMatchObject({ fulfillmentStatus: 'SHIPPED', trackingCarrier: 'Colissimo', trackingNumber: 'TEST123456', shippingAddress: mine.shippingAddress });
    expect(response.body.orders[0].shippedAt).toBeTruthy();
  });

  it('lists only the verified email orders including old orders, excludes internal credentials and paginates', async () => {
    const foreign = `foreign-${email}`;
    const mine = await order();
    const other = await order(foreign);
    for (let index = 0; index < 20; index++)
      await prisma.order.create({
        data: {
          customerName: `Old ${index}`,
          customerEmail: email.toUpperCase(),
          total: 3500,
          status: 'CONFIRMED',
          items: {
            create: {
              productId,
              productName: 'Old product',
              quantity: 1,
              unitPrice: 3500,
              discount: 0,
              lineTotal: 3500,
            },
          },
        },
      });
    const cookie = await login();
    const first = await request(app.getHttpServer())
      .get('/members/orders?page=1')
      .set('Cookie', cookie)
      .expect(200);
    expect(first.body).toMatchObject({ total: 21, page: 1, limit: 20 });
    expect(first.body.orders).toHaveLength(20);
    const second = await request(app.getHttpServer())
      .get('/members/orders?page=2')
      .set('Cookie', cookie)
      .expect(200);
    expect(second.body.orders).toHaveLength(1);
    const rows = [...first.body.orders, ...second.body.orders];
    expect(rows.some((row: { id: string }) => row.id === mine.id)).toBe(true);
    expect(rows.some((row: { id: string }) => row.id === other.id)).toBe(false);
    expect(rows.find((row: { id: string }) => row.id === mine.id).shippingAddress).toEqual(mine.shippingAddress);
    expect(rows.find((row: { id: string }) => row.id === mine.id).shippingFee).toBe(0);
    expect(JSON.stringify(rows)).not.toContain('checkoutKey');
    expect(JSON.stringify(rows)).not.toContain('checkoutIpHash');
    await request(app.getHttpServer())
      .get('/members/orders?page=0')
      .set('Cookie', cookie)
      .expect(400);
    // Clean old fixtures which have no product lines.
    await prisma.order.deleteMany({
      where: { customerEmail: { equals: email, mode: 'insensitive' } },
    });
  });

  it('resumes a reservation made before shipping support without adding a fee', async () => {
    // Same fingerprint as a checkout created before the shipping migration.
    const normalized = {
      customerName: 'Legacy customer',
      customerEmail: email,
      items: [{ productId, quantity: 2 }],
    };
    const legacy = await app.get(OrdersService).create(normalized, {
      checkoutKey: randomUUID(),
      checkoutFingerprint: createHash('sha256')
        .update(JSON.stringify(normalized))
        .digest('hex'),
      checkoutIpHash: createHash('sha256').update('203.0.113.9').digest('hex'),
      reservedUntil: new Date(Date.now() + 30 * 60 * 1000),
    });
    expect(legacy).toMatchObject({ shippingAddress: null, shippingFee: 0, total: 6000 });
    const stripe = app.get(StripeGateway).requireClient();
    const create = vi.spyOn(stripe.checkout.sessions, 'create');
    const cookie = await login();
    const resumed = await request(app.getHttpServer())
      .post(`/members/orders/${legacy.id}/resume`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .expect(200);
    expect(resumed.body).toMatchObject({ total: 6000, shippingFee: 0 });
    const params = create.mock.calls.at(-1)![0] as Stripe.Checkout.SessionCreateParams;
    expect(params.shipping_address_collection).toEqual({ allowed_countries: ['FR'] });
    expect(params.line_items).toHaveLength(1);
    expect(await stock()).toBe(18);
  });

  it('resumes and cancels only an owned unpaid order, with no duplicate stock reservation', async () => {
    const mine = await order();
    const foreign = await order(`foreign-${email}`);
    const cookie = await login();
    for (const action of ['resume', 'cancel']) {
      await request(app.getHttpServer())
        .post(`/members/orders/${foreign.id}/${action}`)
        .set('Cookie', cookie)
        .set('Origin', origin)
        .expect(404);
      await request(app.getHttpServer())
        .post(`/members/orders/${mine.id}/${action}`)
        .set('Cookie', cookie)
        .set('Origin', 'https://evil.test')
        .expect(403);
    }
    const resumed = await request(app.getHttpServer())
      .post(`/members/orders/${mine.id}/resume`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .expect(200);
    expect(resumed.body.sessionId).toBe(mine.checkoutSessionId);
    expect(await stock()).toBe(16);
    expect(await prisma.order.count({ where: { customerEmail: email } })).toBe(
      1,
    );
    for (let index = 0; index < 2; index++)
      await request(app.getHttpServer())
        .post(`/members/orders/${mine.id}/cancel`)
        .set('Cookie', cookie)
        .set('Origin', origin)
        .expect(204);
    expect(await stock()).toBe(18);
    await request(app.getHttpServer())
      .post(`/members/orders/${mine.id}/resume`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .expect(409);
  });

  it('does not let the member cancel or repay an already paid order', async () => {
    const mine = await order();
    mine.session.status = 'complete';
    mine.session.payment_status = 'paid';
    await app.get(PaymentsService).applySession(mine.session, mine);
    const cookie = await login();
    for (const action of ['resume', 'cancel'])
      await request(app.getHttpServer())
        .post(`/members/orders/${mine.id}/${action}`)
        .set('Cookie', cookie)
        .set('Origin', origin)
        .expect(409);
    expect(await stock()).toBe(18);
  });

  it.skipIf(process.env.TEST_SERIAL_DATABASE === 'true')(
    'allows only one simultaneous use of a login link',
    async () => {
      const token = await link();
      const results = await Promise.all([verify(token), verify(token)]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
      expect(
        await prisma.memberSession.count({ where: { member: { email } } }),
      ).toBe(1);
    },
  );
});
