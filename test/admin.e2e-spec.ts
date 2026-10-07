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
