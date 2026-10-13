import { createHash, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import Stripe from 'stripe';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { StripeGateway } from '../src/payments/stripe.gateway.js';
import { ShippingService } from '../src/shipping/shipping.service.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import { OrdersService } from '../src/orders/orders.service.js';
import type { ShippingAddressDto } from '../src/shipping/shipping.dto.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'Stripe checkout (e2e, simulated Stripe)',
  () => {
    let app: INestApplication<App>;
    let prisma: PrismaService;
    let productId: number;
    let email: string;
    let authorization: string;
    let sessions: Map<string, Stripe.Checkout.Session>;
    let keys: Map<string, Stripe.Checkout.Session>;
    let sdk: {
      checkout: {
        sessions: {
          create: ReturnType<typeof vi.fn>;
          retrieve: ReturnType<typeof vi.fn>;
          expire: ReturnType<typeof vi.fn>;
        };
      };
    };
    const secret = 'whsec_local_test_only';

    beforeEach(async () => {
      sessions = new Map();
      keys = new Map();
      sdk = {
        checkout: {
          sessions: {
            create: vi.fn(
              async (
                params: Stripe.Checkout.SessionCreateParams,
                options: Stripe.RequestOptions,
              ) => {
                if (keys.has(options.idempotencyKey!))
                  return keys.get(options.idempotencyKey!);
                const id = `cs_test_${randomUUID().replaceAll('-', '')}`;
                const session = {
                  id,
                  livemode: false,
                  mode: 'payment',
                  currency: 'eur',
                  metadata: params.metadata,
                  client_reference_id: params.client_reference_id,
                  amount_total: params.line_items!.reduce(
                    (sum, item) =>
                      sum +
                      Number(item.price_data!.unit_amount) * item.quantity!,
                    0,
                  ),
                  status: 'open',
                  payment_status: 'unpaid',
                  expires_at: params.expires_at,
                  url: `https://checkout.stripe.com/c/pay/${id}`,
                } as Stripe.Checkout.Session;
                sessions.set(id, session);
                keys.set(options.idempotencyKey!, session);
                return session;
              },
            ),
            retrieve: vi.fn(async (id: string) => {
              const value = sessions.get(id);
              if (!value) throw new Error('Missing Stripe session');
              return { ...value };
            }),
            expire: vi.fn(async (id: string) => {
              const value = sessions.get(id)!;
              if (value.status !== 'open')
                throw new Error('Session already completed');
              value.status = 'expired';
              return { ...value };
            }),
          },
        },
      };
      prisma = new PrismaService(
        new ConfigService({ DATABASE_URL: process.env.TEST_DATABASE_URL }),
      );
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        .overrideProvider(ConfigService)
        .useValue(
          new ConfigService({
            ADMIN_PASSWORD: 'local-admin-password-only',
            STRIPE_SECRET_KEY: 'sk_test_fixture',
            SHIPPING_FR_CENTS: '0',
          }),
        )
        .overrideProvider(StripeGateway)
        .useValue({
          client: sdk,
          origin: 'http://localhost:3000',
          requireClient: () => sdk,
          verify: (body: Buffer, signature: string) =>
            Stripe.webhooks.constructEvent(body, signature, secret),
        })
        .compile();
      app = module.createNestApplication({ rawBody: true });
      await app.init();
      email = `${randomUUID()}@example.com`;
      productId = (
        await prisma.product.create({
          data: {
            name: 'Checkout Hoco',
            slug: randomUUID(),
            price: 3500,
            duoPrice: 6000,
            stock: 20,
          },
        })
      ).id;
      const login = await request(app.getHttpServer())
        .post('/admin/login')
        .send({ password: 'local-admin-password-only' })
        .expect(200);
      authorization = `Bearer ${login.body.token}`;
    });

    afterEach(async () => {
      await prisma.order.deleteMany({
        where: { items: { some: { productId } } },
      });
      await prisma.product.delete({ where: { id: productId } });
      await app.close();
    });

    const body = (checkoutKey: string = randomUUID()) => ({
      shippingAddress: { country: 'FR' as const, line1: '12 rue du Test', line2: '', city: 'Paris', postalCode: '75001', region: '' },
      expectedShippingFee: 0,
      customerName: 'Checkout Client',
      customerEmail: email,
      items: [{ productId, quantity: 2 }],
      checkoutKey,
    });
    const checkout = (value = body()) =>
      request(app.getHttpServer()).post('/payments/checkout').send(value);
    const stock = async () =>
      (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
        .stock;
    const event = async (
      session: Stripe.Checkout.Session,
      type = 'checkout.session.completed',
      signed = true,
    ) => {
      const payload = JSON.stringify({
        id: `evt_${randomUUID()}`,
        object: 'event',
        livemode: false,
        type,
        data: { object: session },
      });
      return request(app.getHttpServer())
        .post('/payments/webhook')
        .set('Content-Type', 'application/json')
        .set(
          'Stripe-Signature',
          signed
            ? Stripe.webhooks.generateTestHeaderString({ payload, secret })
            : 'invalid',
        )
        .send(payload);
    };

    it('charges server shipping once, freezes existing quotes and binds retries to the address', async () => {
      const config = app.get(ConfigService);
      config.set('SHIPPING_FR_CENTS', '590');
      const quote = await request(app.getHttpServer()).get('/payments/shipping').expect(200);
      expect(quote.body.destinations.find((d: { country: string }) => d.country === 'FR').fee).toBe(590);
      const value = { ...body(), expectedShippingFee: 590 };
      await checkout({ ...value, expectedShippingFee: 0 }).expect(409);
      expect(await stock()).toBe(20);
      const result = await checkout(value).expect(200);
      expect(result.body).toMatchObject({ total: 6590, shippingFee: 590 });
      const order = await prisma.order.findUniqueOrThrow({ where: { checkoutSessionId: result.body.sessionId } });
      expect(order.shippingAddress).toEqual(value.shippingAddress);
      expect(order.shippingFee).toBe(590);
      expect(sessions.get(result.body.sessionId)!.amount_total).toBe(6590);
      expect(sdk.checkout.sessions.create.mock.calls[0][0].shipping_address_collection).toBeUndefined();
      config.set('SHIPPING_FR_CENTS', '1200');
      expect((await checkout(value).expect(200)).body.total).toBe(6590);
      await checkout({ ...value, shippingAddress: { ...value.shippingAddress, line1: '99 autre rue' } }).expect(409);
      expect(await stock()).toBe(18);
      const session = sessions.get(result.body.sessionId)!;
      session.status = 'complete'; session.payment_status = 'paid';
      session.amount_total = 6000;
      expect((await event(session)).status).toBe(409);
      session.amount_total = 6590;
      expect((await event(session)).status).toBe(200);
      expect(await stock()).toBe(18);
      const publicStatus = await request(app.getHttpServer()).get(`/payments/checkout/${session.id}`).expect(200);
      expect(publicStatus.body.shippingAddress).toBeUndefined();
      const analytics = await request(app.getHttpServer()).get(`/admin/analytics?month=${new Date().toISOString().slice(0,7)}`).set('Authorization', authorization).expect(200);
      expect(analytics.body.products.find((p: { productId: number }) => p.productId === productId).amount).toBe(6000);
    });

    it.each([
      ['BE', '1000', '', 990], ['CA', 'h2x1y4', 'QC', 2490],
    ])('charges %s shipping and rejects unsupported destination data before reserving stock', async (country, postalCode, region, fee) => {
      const payload = { ...body(), shippingAddress: { ...body().shippingAddress, country, postalCode, region }, expectedShippingFee: fee };
      const result = await request(app.getHttpServer()).post('/payments/checkout').send(payload).expect(200);
      expect(result.body.total).toBe(6000 + Number(fee));
      await request(app.getHttpServer()).post(`/payments/checkout/${result.body.sessionId}/cancel`).expect(200);
      expect(await stock()).toBe(20);
      for (const shippingAddress of [{ ...payload.shippingAddress, country: 'US' }, { ...payload.shippingAddress, postalCode: 'bad' }, null])
        await request(app.getHttpServer()).post('/payments/checkout').send({ ...payload, checkoutKey: randomUUID(), shippingAddress }).expect(400);
      expect(await stock()).toBe(20);
    });

    // Reservation created before shipping support: no stored address, fingerprint without it.
    const legacyReservation = async () => {
      const normalized = {
        customerName: 'Legacy Client',
        customerEmail: email,
        items: [{ productId, quantity: 2 }],
      };
      const checkoutKey = randomUUID();
      const order = await app.get(OrdersService).create(normalized, {
        checkoutKey,
        checkoutFingerprint: createHash('sha256')
          .update(JSON.stringify(normalized))
          .digest('hex'),
        checkoutIpHash: createHash('sha256').update('203.0.113.7').digest('hex'),
        reservedUntil: new Date(Date.now() + 30 * 60 * 1000),
      });
      return { order, normalized, checkoutKey };
    };
    const stripeAddress = (postal_code = '69002') => ({
      shipping_details: {
        name: 'Legacy Client',
        address: {
          country: 'FR',
          line1: '  4 place Bellecour ',
          line2: null,
          city: 'Lyon',
          postal_code,
          state: null,
        },
      },
    });
    const update = (id: string, dto: object) =>
      request(app.getHttpServer())
        .post(`/admin/orders/${id}/fulfillment`)
        .set('Authorization', authorization)
        .send(dto);

    it('stores the Stripe-collected address of a resumed pre-shipping reservation once paid, with historical amounts', async () => {
      const { order, normalized, checkoutKey } = await legacyReservation();
      const resumed = await app.get(PaymentsService).checkout(
        {
          ...normalized,
          checkoutKey,
          shippingAddress: null as unknown as ShippingAddressDto,
          expectedShippingFee: 0,
        },
        '203.0.113.7',
      );
      expect(resumed).toMatchObject({ total: 6000, shippingFee: 0 });
      const params = sdk.checkout.sessions.create.mock.calls.at(-1)![0];
      expect(params.shipping_address_collection).toEqual({ allowed_countries: ['FR'] });
      const session = sessions.get(resumed.sessionId)!;
      Object.assign(session, {
        status: 'complete',
        payment_status: 'paid',
        collected_information: stripeAddress(),
      });
      await update(order.id, { status: 'PREPARING' }).expect(409);
      expect((await event(session)).status).toBe(200);
      const paid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(paid).toMatchObject({
        paymentStatus: 'PAID',
        total: 6000,
        shippingFee: 0,
        shippingAddress: { country: 'FR', line1: '4 place Bellecour', line2: '', city: 'Lyon', postalCode: '69002', region: '' },
      });
      expect(await stock()).toBe(18);
      await update(order.id, { status: 'PREPARING' }).expect(200);
      // A later event never overwrites the stored address.
      Object.assign(session, { collected_information: stripeAddress('75011') });
      expect((await event(session)).status).toBe(200);
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).shippingAddress,
      ).toMatchObject({ postalCode: '69002' });
    });

    it('fills the address of a Stripe session created before the shipping release, via the server status check', async () => {
      const { order } = await legacyReservation();
      // Session opened by the previous release (old API field, address collected by Stripe).
      const id = `cs_test_${randomUUID().replaceAll('-', '')}`;
      sessions.set(id, {
        id,
        livemode: false,
        mode: 'payment',
        currency: 'eur',
        metadata: { orderId: order.id },
        client_reference_id: order.id,
        amount_total: 6000,
        status: 'complete',
        payment_status: 'paid',
        expires_at: Math.floor(Date.now() / 1000) + 1800,
        url: null,
        ...stripeAddress(),
      } as unknown as Stripe.Checkout.Session);
      await prisma.order.update({ where: { id: order.id }, data: { checkoutSessionId: id } });
      const status = await request(app.getHttpServer()).get(`/payments/checkout/${id}`).expect(200);
      expect(status.body).toMatchObject({ paymentStatus: 'PAID', total: 6000, shippingFee: 0 });
      expect(status.body.shippingAddress).toBeUndefined();
      const paid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(paid.shippingAddress).toMatchObject({ city: 'Lyon', postalCode: '69002' });
    });

    it('keeps a paid order without usable address unshippable, then recovers it from a re-sent webhook', async () => {
      const { order, normalized, checkoutKey } = await legacyReservation();
      const resumed = await app.get(PaymentsService).checkout(
        { ...normalized, checkoutKey, shippingAddress: null as unknown as ShippingAddressDto, expectedShippingFee: 0 },
        '203.0.113.7',
      );
      const session = sessions.get(resumed.sessionId)!;
      // Overseas postcode: not deliverable at mainland conditions, so not stored.
      Object.assign(session, { status: 'complete', payment_status: 'paid', collected_information: stripeAddress('97100') });
      expect((await event(session)).status).toBe(200);
      const paid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(paid).toMatchObject({ paymentStatus: 'PAID', shippingAddress: null, total: 6000 });
      await update(order.id, { status: 'PREPARING' }).expect(409);
      // After the address is corrected on Stripe's side, re-sending the event fills it once.
      Object.assign(session, { collected_information: stripeAddress('69002') });
      expect((await event(session)).status).toBe(200);
      await update(order.id, { status: 'PREPARING' }).expect(200);
    });

    it('allows only paid addressed orders through preparation, tracked shipment and delivery; retries are safe', async () => {
      const result = await checkout().expect(200);
      const session = sessions.get(result.body.sessionId)!;
      const id = session.metadata!.orderId;
      const update = (dto: object) => request(app.getHttpServer()).post(`/admin/orders/${id}/fulfillment`).set('Authorization', authorization).send(dto);
      await request(app.getHttpServer()).post(`/admin/orders/${id}/fulfillment`).send({ status: 'PREPARING' }).expect(401);
      await update({ status: 'PREPARING' }).expect(409);
      session.status = 'complete'; session.payment_status = 'paid';
      expect((await event(session)).status).toBe(200);
      await update({ status: 'DELIVERED' }).expect(409);
      const preparing = await update({ status: 'PREPARING' }).expect(200);
      expect(preparing.body.fulfillmentStatus).toBe('PREPARING');
      await update({ status: 'PREPARING' }).expect(200);
      await update({ status: 'SHIPPED' }).expect(400);
      await update({ status: 'SHIPPED', trackingCarrier: 'Colissimo', trackingNumber: 'javascript:alert(1)' }).expect(400);
      const shipment = { status: 'SHIPPED', trackingCarrier: 'Colissimo', trackingNumber: 'TEST12345678' };
      const shipped = await update(shipment).expect(200);
      expect(shipped.body.shippedAt).toBeTruthy();
      expect((await update(shipment).expect(200)).body.shippedAt).toBe(shipped.body.shippedAt);
      await update({ ...shipment, trackingNumber: 'OTHER123' }).expect(409);
      await update({ status: 'PREPARING' }).expect(409);
      const delivered = await update({ status: 'DELIVERED' }).expect(200);
      expect(delivered.body.deliveredAt).toBeTruthy();
      expect((await update({ status: 'DELIVERED' }).expect(200)).body.deliveredAt).toBe(delivered.body.deliveredAt);
      expect(await stock()).toBe(18);
      expect((await prisma.order.findUniqueOrThrow({ where: { id } })).paymentStatus).toBe('PAID');
      // Historical paid reservations have no shipping address and must not be dispatched blindly.
      await prisma.order.update({ where: { id }, data: { shippingAddress: (await import('../src/generated/prisma/client.js')).Prisma.DbNull, fulfillmentStatus: 'UNFULFILLED' } });
      await update({ status: 'PREPARING' }).expect(409);
    });

    it('reserves two units at server Duo prices and reuses the same reservation on retries', async () => {
      const value = body();
      const first = await checkout(value).expect(200);
      const second = await checkout(value).expect(200);
      expect(second.body.sessionId).toBe(first.body.sessionId);
      expect(first.body).toMatchObject({ total: 6000, testMode: true });
      expect(await stock()).toBe(18);
      expect(
        await prisma.order.count({ where: { customerEmail: email } }),
      ).toBe(1);
      expect(sdk.checkout.sessions.create).toHaveBeenCalledTimes(1);
      expect(sdk.checkout.sessions.create.mock.calls[0][0]).toMatchObject({
        allowed_payment_method_types: ['card'],
        mode: 'payment',
      });
      expect(first.headers['cache-control']).toBe('no-store');
      await checkout({ ...value, items: [{ productId, quantity: 1 }] }).expect(
        409,
      );
      expect(await stock()).toBe(18);
    });

    it('checks out three distinct products, tracks separate stocks and validates the test Stripe total', async () => {
      const fixtures = await prisma.product.createManyAndReturn({
        data: [
          { name: 'CONNECTA Câble USB-C TEST', slug: `cable-test-${randomUUID()}`, price: 990, stock: 12 },
          { name: 'CONNECTA Chargeur 20W TEST', slug: `chargeur-test-${randomUUID()}`, price: 1990, stock: 7 },
        ],
      });
      try {
        const lines = [
          { productId, quantity: 2 },
          { productId: fixtures[0].id, quantity: 1 },
          { productId: fixtures[1].id, quantity: 1 },
        ];
        const response = await checkout({ ...body(), items: lines }).expect(200);
        expect(response.body).toMatchObject({ total: 8980, shippingFee: 0, testMode: true });
        const session = sessions.get(response.body.sessionId)!;
        const stripeLines = sdk.checkout.sessions.create.mock.calls[0][0].line_items!;
        expect(stripeLines).toHaveLength(3);
        expect(stripeLines.map((item: Stripe.Checkout.SessionCreateParams.LineItem) => item.price_data!.unit_amount))
          .toEqual([6000, 990, 1990]);
        expect(session.amount_total).toBe(8980);
        const items = await prisma.orderItem.findMany({
          where: { order: { checkoutSessionId: session.id } },
          orderBy: { productId: 'asc' },
        });
        expect(items).toHaveLength(3);
        expect(items.reduce((total, item) => total + item.lineTotal, 0)).toBe(8980);
        const stocks = async () => Promise.all(
          [productId, fixtures[0].id, fixtures[1].id].map(async id =>
            (await prisma.product.findUniqueOrThrow({ where: { id } })).stock),
        );
        expect(await stocks()).toEqual([18, 11, 6]);
        session.status = 'complete';
        session.payment_status = 'paid';
        await event(session).then(result => expect(result.status).toBe(200));
        await event(session).then(result => expect(result.status).toBe(200));
        expect(await stocks()).toEqual([18, 11, 6]);
        const status = await request(app.getHttpServer())
          .get(`/payments/checkout/${session.id}`).expect(200);
        expect(status.body).toMatchObject({ total: 8980, paymentStatus: 'PAID' });
      } finally {
        await prisma.order.deleteMany({ where: { items: { some: { productId: { in: fixtures.map(item => item.id) } } } } });
        await prisma.product.deleteMany({ where: { id: { in: fixtures.map(item => item.id) } } });
      }
    });

    it('restores each reference of an expired mixed Stripe reservation', async () => {
      const fixture = await prisma.product.create({
        data: { name: 'CONNECTA Câble USB-C TEST', slug: `cancel-test-${randomUUID()}`, price: 990, stock: 5 },
      });
      try {
        const response = await checkout({
          ...body(), items: [{ productId, quantity: 1 }, { productId: fixture.id, quantity: 2 }],
        }).expect(200);
        expect(await stock()).toBe(19);
        expect((await prisma.product.findUniqueOrThrow({ where: { id: fixture.id } })).stock).toBe(3);
        await request(app.getHttpServer())
          .post(`/payments/checkout/${response.body.sessionId}/cancel`).expect(200);
        expect(await stock()).toBe(20);
        expect((await prisma.product.findUniqueOrThrow({ where: { id: fixture.id } })).stock).toBe(5);
      } finally {
        await prisma.order.deleteMany({ where: { items: { some: { productId: fixture.id } } } });
        await prisma.product.delete({ where: { id: fixture.id } });
      }
    });

    it('enforces ten units across duplicate lines and accepts the ten-unit boundary', async () => {
      for (const items of [
        [{ productId, quantity: 11 }],
        [
          { productId, quantity: 6 },
          { productId, quantity: 5 },
        ],
      ]) {
        await checkout({ ...body(), items }).expect(400);
        expect(await stock()).toBe(20);
      }
      await checkout({
        ...body(),
        items: [{ productId, quantity: 10 }],
      }).expect(200);
      expect(await stock()).toBe(10);
    });

    it('blocks another unpaid reservation for a normalized email, then permits a new one after cancellation', async () => {
      const first = await checkout().expect(200);
      const blocked = await checkout({
        ...body(),
        customerEmail: `  ${email.toUpperCase()}  `,
      }).expect(409);
      expect(blocked.body.code).toBe('ACTIVE_RESERVATION');
      expect(await stock()).toBe(18);
      await request(app.getHttpServer())
        .post(`/payments/checkout/${first.body.sessionId}/cancel`)
        .expect(200);
      await checkout().expect(200);
      expect(await stock()).toBe(18);
    });

    it('allows a new order after verified payment and reports only unpaid units as reserved', async () => {
      const first = await checkout().expect(200);
      const readProducts = () =>
        request(app.getHttpServer())
          .get('/admin/products')
          .set('Authorization', authorization)
          .expect(200);
      const before = await readProducts();
      expect(
        before.body.find((p: { id: number }) => p.id === productId),
      ).toMatchObject({ stock: 18, reservedUnits: 2 });
      const session = sessions.get(first.body.sessionId)!;
      session.status = 'complete';
      session.payment_status = 'paid';
      expect((await event(session)).status).toBe(200);
      const paid = await readProducts();
      expect(
        paid.body.find((p: { id: number }) => p.id === productId),
      ).toMatchObject({ stock: 18, reservedUnits: 0 });
      const second = await checkout().expect(200);
      await request(app.getHttpServer())
        .post(`/payments/checkout/${second.body.sessionId}/cancel`)
        .expect(200);
      const cancelled = await readProducts();
      expect(
        cancelled.body.find((p: { id: number }) => p.id === productId),
      ).toMatchObject({ stock: 18, reservedUnits: 0 });
    });

    it('removes verified payments from the quota while retaining unpaid and cancelled reservations', async () => {
      const cancelled = await checkout({
        ...body(),
        customerEmail: `cancelled-${email}`,
      }).expect(200);
      await request(app.getHttpServer())
        .post(`/payments/checkout/${cancelled.body.sessionId}/cancel`)
        .expect(200);
      await checkout({ ...body(), customerEmail: `waiting-${email}` }).expect(
        200,
      );
      const value = body();
      const toPay = await checkout(value).expect(200);
      await checkout({ ...body(), customerEmail: `blocked-${email}` }).expect(
        429,
      );
      // An open reservation can still be resumed even when the quota is full.
      await checkout(value).expect(200);
      const session = sessions.get(toPay.body.sessionId)!;
      session.status = 'complete';
      session.payment_status = 'paid';
      expect((await event(session)).status).toBe(200);
      const next = await checkout().expect(200);
      expect(await stock()).toBe(14);
      // Cancelling the next order restores its stock but keeps it in the abuse quota.
      await request(app.getHttpServer())
        .post(`/payments/checkout/${next.body.sessionId}/cancel`)
        .expect(200);
      await checkout().expect(429);
      expect(await stock()).toBe(16);
    });

    it('limits new reservations from the same connection even with different emails and survives service restart', async () => {
      for (let index = 0; index < 3; index++) {
        const value = { ...body(), customerEmail: `${index}-${email}` };
        const response = await checkout(value).expect(200);
        await checkout(value).expect(200); // Idempotent retries never consume the quota.
        await request(app.getHttpServer())
          .post(`/payments/checkout/${response.body.sessionId}/cancel`)
          .expect(200);
      }
      await checkout({ ...body(), customerEmail: `fourth-${email}` }).expect(
        429,
      );
      const previous = await prisma.order.findFirstOrThrow({
        where: { items: { some: { productId } } },
      });
      const sourceIp = ['::1', '127.0.0.1', '::ffff:127.0.0.1'].find(
        (ip) =>
          createHash('sha256').update(ip).digest('hex') ===
          previous.checkoutIpHash,
      );
      expect(sourceIp).toBeDefined();
      const restarted = new PaymentsService(
        prisma,
        app.get(
          (await import('../src/orders/orders.service.js')).OrdersService,
        ),
        app.get(StripeGateway),
        app.get(ShippingService),
      );
      await expect(restarted.checkout(body(), sourceIp!)).rejects.toMatchObject(
        { status: 429 },
      );
      expect(await stock()).toBe(20);
      await prisma.order.updateMany({
        where: { items: { some: { productId } } },
        data: { createdAt: new Date(Date.now() - 32 * 60 * 1000) },
      });
      await checkout().expect(200);
    });

    it.skipIf(process.env.TEST_SERIAL_DATABASE === 'true')(
      'allows only one simultaneous unpaid reservation for an email with different checkout keys',
      async () => {
        const results = await Promise.all([checkout(), checkout()]);
        expect(results.map((result) => result.status).sort()).toEqual([
          200, 409,
        ]);
        expect(await stock()).toBe(18);
        expect(
          await prisma.order.count({ where: { customerEmail: email } }),
        ).toBe(1);
      },
    );

    it.skipIf(process.env.TEST_SERIAL_DATABASE === 'true')(
      'enforces the connection quota during simultaneous reservations with different emails',
      async () => {
        const results = await Promise.all(
          Array.from({ length: 5 }, (_, index) =>
            checkout({ ...body(), customerEmail: `${index}-${email}` }),
          ),
        );
        expect(results.map((result) => result.status).sort()).toEqual([
          200, 200, 200, 429, 429,
        ]);
        expect(await stock()).toBe(14);
      },
    );

    it('rejects forged prices, invalid keys and manual unpaid orders when Stripe is configured', async () => {
      await checkout({ ...body(), total: 1 } as ReturnType<typeof body>).expect(
        400,
      );
      await checkout({ ...body(), checkoutKey: 'not-a-uuid' }).expect(400);
      await request(app.getHttpServer())
        .post('/orders')
        .send({
          customerName: 'Test',
          customerEmail: email,
          items: [{ productId, quantity: 2 }],
        })
        .expect(503);
      expect(await stock()).toBe(20);
    });

    it('only marks a payment paid after verifying Stripe and never decrements stock twice', async () => {
      const response = await checkout().expect(200);
      const session = sessions.get(response.body.sessionId)!;
      const before = await request(app.getHttpServer())
        .get(`/payments/checkout/${session.id}`)
        .expect(200);
      expect(before.body.paymentStatus).toBe('UNPAID');
      const id = before.body.orderId;
      await request(app.getHttpServer())
        .post(`/admin/orders/${id}/status`)
        .set('Authorization', authorization)
        .send({ status: 'CONFIRMED' })
        .expect(409);
      await event(session, 'checkout.session.completed', false).then((result) =>
        expect(result.status).toBe(400),
      );
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id } })).paymentStatus,
      ).toBe('UNPAID');
      session.status = 'complete';
      session.payment_status = 'paid';
      expect((await event(session)).status).toBe(200);
      const firstPaidAt = (
        await prisma.order.findUniqueOrThrow({ where: { id } })
      ).paidAt;
      expect((await event(session)).status).toBe(200);
      // A late expired event must not undo the current paid Stripe state.
      expect(
        (
          await event(
            { ...session, status: 'expired', payment_status: 'unpaid' },
            'checkout.session.expired',
          )
        ).status,
      ).toBe(200);
      const after = await request(app.getHttpServer())
        .get(`/payments/checkout/${session.id}`)
        .expect(200);
      expect(after.body).toMatchObject({
        paymentStatus: 'PAID',
        total: 6000,
        testMode: true,
      });
      expect(after.body.customerEmail).toBeUndefined();
      const paid = await prisma.order.findUniqueOrThrow({ where: { id } });
      expect(paid.status).toBe('CONFIRMED');
      expect(paid.paidAt).toEqual(firstPaidAt);
      await request(app.getHttpServer())
        .post(`/payments/checkout/${session.id}/cancel`)
        .expect(409);
      await request(app.getHttpServer())
        .post(`/admin/orders/${id}/status`)
        .set('Authorization', authorization)
        .send({ status: 'CANCELLED' })
        .expect(409);
      expect(await stock()).toBe(18);
    });

    it('cancels the Stripe session before freeing stock and handles repeated expiry safely', async () => {
      const response = await checkout().expect(200);
      const session = sessions.get(response.body.sessionId)!;
      await request(app.getHttpServer())
        .post(`/payments/checkout/${session.id}/cancel`)
        .expect(200);
      expect(sdk.checkout.sessions.expire).toHaveBeenCalledWith(session.id);
      await request(app.getHttpServer())
        .post(`/payments/checkout/${session.id}/cancel`)
        .expect(200);
      expect((await event(session, 'checkout.session.expired')).status).toBe(
        200,
      );
      expect(await stock()).toBe(20);
      await request(app.getHttpServer())
        .get(`/payments/checkout/${session.id}`)
        .expect(200)
        .then((result) => expect(result.body.paymentStatus).toBe('EXPIRED'));
    });

    it('does not release stock when Stripe is unavailable or payment wins a cancellation race', async () => {
      const response = await checkout().expect(200);
      const session = sessions.get(response.body.sessionId)!;
      sdk.checkout.sessions.retrieve.mockRejectedValueOnce(
        new Error('offline'),
      );
      await request(app.getHttpServer())
        .post(`/payments/checkout/${session.id}/cancel`)
        .expect(500);
      expect(await stock()).toBe(18);
      sdk.checkout.sessions.expire.mockImplementationOnce(async () => {
        session.status = 'complete';
        session.payment_status = 'paid';
        throw new Error('Payment completed');
      });
      await request(app.getHttpServer())
        .post(`/payments/checkout/${session.id}/cancel`)
        .expect(409);
      expect(
        (
          await prisma.order.findFirstOrThrow({
            where: { customerEmail: email },
          })
        ).paymentStatus,
      ).toBe('PAID');
      expect(await stock()).toBe(18);
    });

    it('recovers expiry without a webhook after restart and preserves legacy orders', async () => {
      const response = await checkout().expect(200);
      const order = await prisma.order.findFirstOrThrow({
        where: { customerEmail: email },
      });
      await prisma.order.update({
        where: { id: order.id },
        data: { reservedUntil: new Date(0) },
      });
      sessions.get(response.body.sessionId)!.status = 'expired';
      await app.get(PaymentsService).sweep();
      expect(await stock()).toBe(20);
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
          .paymentStatus,
      ).toBe('EXPIRED');
    });

    it('keeps an ambiguous creation attempt reserved and allows safe retry with the same key', async () => {
      const value = body();
      const create = sdk.checkout.sessions.create.getMockImplementation() as (
        params: Stripe.Checkout.SessionCreateParams,
        options: Stripe.RequestOptions,
      ) => Promise<Stripe.Checkout.Session>;
      sdk.checkout.sessions.create.mockImplementationOnce(
        async (
          params: Stripe.Checkout.SessionCreateParams,
          options: Stripe.RequestOptions,
        ) => {
          await create(params, options);
          throw new Error('Lost response');
        },
      );
      await checkout(value).expect(503);
      expect(await stock()).toBe(18);
      const result = await checkout(value).expect(200);
      expect(keys.size).toBe(1);
      expect(result.body.total).toBe(6000);
      expect(await stock()).toBe(18);
    });

    it('rejects mismatched amounts and non-paid completed sessions', async () => {
      const response = await checkout().expect(200);
      const session = sessions.get(response.body.sessionId)!;
      session.status = 'complete';
      session.payment_status = 'unpaid';
      expect((await event(session)).status).toBe(200);
      expect(
        (
          await prisma.order.findFirstOrThrow({
            where: { customerEmail: email },
          })
        ).paymentStatus,
      ).toBe('UNPAID');
      session.payment_status = 'paid';
      session.amount_total = 1;
      expect((await event(session)).status).toBe(409);
      expect(await stock()).toBe(18);
    });

    it.skipIf(process.env.TEST_SERIAL_DATABASE === 'true')(
      'reuses the last-stock reservation for simultaneous identical checkout requests',
      async () => {
        await prisma.product.update({
          where: { id: productId },
          data: { stock: 2 },
        });
        const value = body();
        const responses = await Promise.all([checkout(value), checkout(value)]);
        expect(responses.map((result) => result.status)).toEqual([200, 200]);
        expect(responses[0].body.sessionId).toBe(responses[1].body.sessionId);
        expect(await stock()).toBe(0);
        expect(
          await prisma.order.count({ where: { customerEmail: email } }),
        ).toBe(1);
      },
    );
  },
);
