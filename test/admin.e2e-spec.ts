import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { configureCors } from '../src/configure-cors.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Admin (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let productId: number;
  let email: string;
  let authorization: string;
  const password = 'test-only-admin-password-123';

  beforeAll(async () => {
    prisma = new PrismaService(
      new ConfigService({ DATABASE_URL: process.env.TEST_DATABASE_URL }),
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(ConfigService)
      .useValue(new ConfigService({ ADMIN_PASSWORD: password }))
      .compile();
    app = module.createNestApplication();
    configureCors(app, 'http://localhost:3000');
    await app.init();
    const login = await request(app.getHttpServer())
      .post('/admin/login')
      .send({ password })
      .expect(200);
    authorization = `Bearer ${login.body.token}`;
  });

  beforeEach(async () => {
    const key = randomUUID();
    email = `${key}@example.com`;
    const product = await prisma.product.create({
      data: {
        name: 'Admin test Hoco',
        slug: key,
        price: 3500,
        duoPrice: 6000,
        stock: 0,
      },
    });
    productId = product.id;
  });

  afterEach(async () => {
    await prisma.order.deleteMany({ where: { customerEmail: email } });
    await prisma.product.delete({ where: { id: productId } });
  });
  afterAll(async () => {
    await app.close();
  });

  const restock = (quantity: unknown) =>
    request(app.getHttpServer())
      .post(`/admin/products/${productId}/restock`)
      .set('Authorization', authorization)
      .send({ quantity });

  const changeStatus = (id: string, status: unknown) =>
    request(app.getHttpServer())
      .post(`/admin/orders/${id}/status`)
      .set('Authorization', authorization)
      .send({ status });

  const createOrder = async () => {
    await restock(5).expect(201);
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({
        customerName: 'Test Admin',
        customerEmail: email,
        items: [{ productId, quantity: 2 }],
      })
      .expect(201);
    return response.body.id as string;
  };

  it('protects and validates monthly analytics', async () => {
    await request(app.getHttpServer())
      .get('/admin/analytics?month=2026-03')
      .expect(401);
    for (const query of [
      '',
      '?month=2026-13',
      '?month=2026-3',
      '?month=1999-12',
      '?month=2026-03&extra=true',
    ]) {
      await request(app.getHttpServer())
        .get(`/admin/analytics${query}`)
        .set('Authorization', authorization)
        .expect(400);
    }
  });

  it('aggregates every monthly order with Paris DST boundaries, snapshots, statuses and product ranking', async () => {
    const extra = await prisma.product.create({
      data: { name: 'Cable', slug: randomUUID(), price: 2000 },
    });
    const seed = async (
      createdAt: string,
      status: 'PENDING' | 'CONFIRMED' | 'CANCELLED',
      quantity: number,
      amount: number,
      id = productId,
      discount = 0,
    ) => {
      return prisma.order.create({
        data: {
          customerName: 'Analytics',
          customerEmail: email,
          createdAt: new Date(createdAt),
          status,
          total: amount,
          items: {
            create: {
              productId: id,
              productName: 'Historical name',
              quantity,
              unitPrice: (amount + discount) / quantity,
              lineTotal: amount,
              discount,
            },
          },
        },
      });
    };
    try {
      await seed('2026-02-28T22:59:59.999Z', 'CONFIRMED', 100, 100000);
      await seed(
        '2026-02-28T23:00:00.000Z',
        'PENDING',
        2,
        6000,
        productId,
        1000,
      );
      await seed('2026-03-31T21:59:59.999Z', 'CONFIRMED', 1, 3500);
      await seed('2026-03-31T22:00:00.000Z', 'CONFIRMED', 100, 100000);
      await seed('2026-03-15T12:00:00.000Z', 'CANCELLED', 100, 300000);
      for (let i = 0; i < 21; i++)
        await seed('2026-03-15T12:00:00.000Z', 'CONFIRMED', 1, 1000, extra.id);
      await prisma.product.update({
        where: { id: productId },
        data: { name: 'Renamed Hoco', price: 9999, active: false },
      });
      const result = await request(app.getHttpServer())
        .get('/admin/analytics?month=2026-03')
        .set('Authorization', authorization)
        .expect(200);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).toMatchObject({
        month: '2026-03',
        timeZone: 'Europe/Paris',
        amount: 30500,
        orderCount: 23,
        units: 24,
        averageOrder: 1326,
        pending: { count: 1, amount: 6000 },
        confirmed: { count: 22, amount: 24500 },
        cancelled: { count: 1, amount: 300000 },
        products: [
          {
            productId: extra.id,
            name: 'Cable',
            units: 21,
            amount: 21000,
            discount: 0,
            orderCount: 21,
          },
          {
            productId,
            name: 'Renamed Hoco',
            units: 3,
            amount: 9500,
            discount: 1000,
            orderCount: 2,
          },
        ],
      });
      // Cancelling an order updates its original purchase month, not the cancellation month.
      const pending = await prisma.order.findFirstOrThrow({
        where: { customerEmail: email, status: 'PENDING' },
      });
      await changeStatus(pending.id, 'CANCELLED').expect(200);
      const updated = await request(app.getHttpServer())
        .get('/admin/analytics?month=2026-03')
        .set('Authorization', authorization)
        .expect(200);
      expect(updated.body.amount).toBe(24500);
      expect(updated.body.units).toBe(22);
      expect(updated.body.pending.count).toBe(0);
      const empty = await request(app.getHttpServer())
        .get('/admin/analytics?month=2099-12')
        .set('Authorization', authorization)
        .expect(200);
      expect(empty.body).toMatchObject({
        amount: 0,
        orderCount: 0,
        units: 0,
        averageOrder: 0,
        products: [],
      });
    } finally {
      await prisma.order.deleteMany({ where: { customerEmail: email } });
      await prisma.product.delete({ where: { id: extra.id } });
    }
  });

  it('confirms without changing stock or historical amounts and permits safe repetition', async () => {
    const id = await createOrder();
    for (let i = 0; i < 2; i++) {
      const result = await changeStatus(id, 'CONFIRMED').expect(200);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).toMatchObject({
        id,
        status: 'CONFIRMED',
        total: 6000,
      });
      expect(result.body.items[0]).toMatchObject({
        quantity: 2,
        discount: 1000,
        lineTotal: 6000,
      });
    }
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
        .stock,
    ).toBe(3);
  });

  it.each(['PENDING', 'CONFIRMED'] as const)(
    'cancels a %s order and restores stock exactly once',
    async (status) => {
      const id = await createOrder();
      if (status === 'CONFIRMED') await changeStatus(id, status).expect(200);
      await prisma.product.update({
        where: { id: productId },
        data: { active: false },
      });
      await changeStatus(id, 'CANCELLED').expect(200);
      await changeStatus(id, 'CANCELLED').expect(200);
      await changeStatus(id, 'CONFIRMED').expect(409);
      const product = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
      });
      expect(product.stock).toBe(5);
      expect(product.active).toBe(false);
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id } })).status,
      ).toBe('CANCELLED');
    },
  );

  it('validates order actions and protects them from unauthenticated callers', async () => {
    const id = await createOrder();
    await request(app.getHttpServer())
      .post(`/admin/orders/${id}/status`)
      .send({ status: 'CANCELLED' })
      .expect(401);
    for (const status of ['PENDING', 'PAID', null, 1])
      await changeStatus(id, status).expect(400);
    await changeStatus('invalid-id', 'CANCELLED').expect(400);
    await changeStatus(randomUUID(), 'CANCELLED').expect(404);
    await request(app.getHttpServer())
      .post(`/admin/orders/${id}/status`)
      .set('Authorization', authorization)
      .send({ status: 'CONFIRMED', total: 0 })
      .expect(400);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('PENDING');
  });

  it('rolls back the cancellation and all stock changes when any restoration would overflow', async () => {
    const extra = await prisma.product.create({
      data: {
        name: 'Extra',
        slug: randomUUID(),
        price: 1000,
        stock: 2,
      },
    });
    try {
      await restock(2).expect(201);
      const response = await request(app.getHttpServer())
        .post('/orders')
        .send({
          customerName: 'Test Admin',
          customerEmail: email,
          items: [
            { productId, quantity: 1 },
            { productId: extra.id, quantity: 1 },
          ],
        })
        .expect(201);
      await prisma.product.update({
        where: { id: extra.id },
        data: { stock: 2147483647 },
      });
      await changeStatus(response.body.id, 'CANCELLED').expect(409);
      expect(
        (
          await prisma.order.findUniqueOrThrow({
            where: { id: response.body.id },
          })
        ).status,
      ).toBe('PENDING');
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
          .stock,
      ).toBe(1);
    } finally {
      await prisma.order.deleteMany({ where: { customerEmail: email } });
      await prisma.product.delete({ where: { id: extra.id } });
    }
  });

  it.skipIf(process.env.TEST_SERIAL_DATABASE === 'true')(
    'restores stock once during simultaneous confirmation and cancellations',
    async () => {
      const id = await createOrder();
      const responses = await Promise.all([
        changeStatus(id, 'CONFIRMED'),
        changeStatus(id, 'CANCELLED'),
        changeStatus(id, 'CANCELLED'),
      ]);
      expect([200, 409]).toContain(responses[0].status);
      expect(responses.slice(1).map((r) => r.status)).toEqual([200, 200]);
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id } })).status,
      ).toBe('CANCELLED');
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
          .stock,
      ).toBe(5);
    },
  );

  it('protects order data, product data and stock changes', async () => {
    await request(app.getHttpServer()).get('/admin/orders').expect(401);
    await request(app.getHttpServer()).get('/admin/products').expect(401);
    await request(app.getHttpServer())
      .post(`/admin/products/${productId}/restock`)
      .send({ quantity: 20 })
      .expect(401);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
        .stock,
    ).toBe(0);
  });

  it('rejects incorrect credentials and unexpected login fields', async () => {
    await request(app.getHttpServer())
      .post('/admin/login')
      .send({ password: 'wrong' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/admin/login')
      .send({ password, admin: true })
      .expect(400);
  });

  it('permits Authorization in browser preflight', async () => {
    const response = await request(app.getHttpServer())
      .options('/admin/products')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization')
      .expect(204);
    expect(response.headers['access-control-allow-headers']).toContain(
      'Authorization',
    );
  });

  it('adds stock and makes a sold-out product orderable again', async () => {
    const response = await restock(20).expect(201);
    expect(response.body).toMatchObject({ id: productId, stock: 20 });
    await restock(3).expect(201);
    const order = await request(app.getHttpServer())
      .post('/orders')
      .send({
        customerName: 'Test Admin',
        customerEmail: email,
        items: [{ productId, quantity: 2 }],
      })
      .expect(201);
    expect(order.body.total).toBe(6000);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
        .stock,
    ).toBe(21);
  });

  it('returns customer details and historical totals in a paginated order list', async () => {
    await restock(2).expect(201);
    const order = await request(app.getHttpServer())
      .post('/orders')
      .send({
        customerName: 'Test Admin',
        customerEmail: email,
        items: [{ productId, quantity: 2 }],
      })
      .expect(201);
    await prisma.product.update({
      where: { id: productId },
      data: { price: 5000, duoPrice: null },
    });
    const list = await request(app.getHttpServer())
      .get('/admin/orders?limit=100&page=1')
      .set('Authorization', authorization)
      .expect(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body).toMatchObject({ page: 1, limit: 100 });
    expect(list.body.orders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: order.body.id,
          customerName: 'Test Admin',
          customerEmail: email,
          total: 6000,
          items: [
            expect.objectContaining({
              productName: 'Admin test Hoco',
              quantity: 2,
              lineTotal: 6000,
              discount: 1000,
            }),
          ],
        }),
      ]),
    );
    await request(app.getHttpServer())
      .get('/admin/orders?page=0')
      .set('Authorization', authorization)
      .expect(400);
    await request(app.getHttpServer())
      .get('/admin/orders?limit=101')
      .set('Authorization', authorization)
      .expect(400);
  });

  it('lists inactive products without publishing them to the storefront', async () => {
    await prisma.product.update({
      where: { id: productId },
      data: { active: false },
    });
    const response = await request(app.getHttpServer())
      .get('/admin/products')
      .set('Authorization', authorization)
      .expect(200);
    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: productId, active: false }),
      ]),
    );
    await restock(5).expect(201);
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: productId },
    });
    expect(product.active).toBe(false);
    await request(app.getHttpServer())
      .get(`/products/${product.slug}`)
      .expect(404);
  });

  it.each([0, -1, 1.5, 10001, '2'])(
    'rejects invalid restock quantity %s',
    async (quantity) => {
      await restock(quantity).expect(400);
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
          .stock,
      ).toBe(0);
    },
  );

  it('rejects a nonexistent product, extra fields and integer overflow', async () => {
    await request(app.getHttpServer())
      .post('/admin/products/2147483647/restock')
      .set('Authorization', authorization)
      .send({ quantity: 1 })
      .expect(404);
    await request(app.getHttpServer())
      .post(`/admin/products/${productId}/restock`)
      .set('Authorization', authorization)
      .send({ quantity: 1, price: 1 })
      .expect(400);
    await prisma.product.update({
      where: { id: productId },
      data: { stock: 2147483647 },
    });
    await restock(1).expect(409);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
        .stock,
    ).toBe(2147483647);
  });

  it('revokes a session on logout', async () => {
    const login = await request(app.getHttpServer())
      .post('/admin/login')
      .send({ password })
      .expect(200);
    const auth = `Bearer ${login.body.token}`;
    await request(app.getHttpServer())
      .post('/admin/logout')
      .set('Authorization', auth)
      .expect(204);
    await request(app.getHttpServer())
      .get('/admin/orders')
      .set('Authorization', auth)
      .expect(401);
  });

  it.skipIf(process.env.TEST_SERIAL_DATABASE === 'true')(
    'does not lose concurrent restocks or order decrements',
    async () => {
      await restock(1).expect(201);
      const responses = await Promise.all([
        restock(2),
        restock(3),
        request(app.getHttpServer())
          .post('/orders')
          .send({
            customerName: 'Test Admin',
            customerEmail: email,
            items: [{ productId, quantity: 1 }],
          }),
      ]);
      expect(responses.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
          .stock,
      ).toBe(5);
    },
  );
});
