import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// Use a dedicated migrated database, never the development DATABASE_URL.
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'Products and orders (e2e)',
  () => {
    let app: INestApplication<App>;
    let prisma: PrismaService;
    let productIds: number[];
    let customerEmail: string;

    beforeAll(async () => {
      prisma = new PrismaService(
        new ConfigService({ DATABASE_URL: process.env.TEST_DATABASE_URL }),
      );
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        .compile();
      app = module.createNestApplication();
      await app.init();
    });

    beforeEach(async () => {
      productIds = [];
      const key = randomUUID();
      customerEmail = `${key}@example.com`;
      const products = await prisma.product.createManyAndReturn({
        data: [
          { name: 'Hoco EW75', slug: `${key}-hoco`, price: 3500, stock: 3 },
          {
            name: 'Second produit',
            slug: `${key}-other`,
            price: 1000,
            stock: 0,
          },
        ],
      });
      productIds = products
        .sort((a, b) => a.id - b.id)
        .map((product) => product.id);
    });

    afterEach(async () => {
      await prisma.order.deleteMany({ where: { customerEmail } });
      await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    });

    afterAll(async () => {
      await app.close();
    });

    const body = (items = [{ productId: productIds[0], quantity: 2 }]) => ({
      customerName: 'Saïd',
      customerEmail,
      items,
    });

    it('preserves product routes and returns 404 for a missing slug', async () => {
      const product = await prisma.product.findUniqueOrThrow({
        where: { id: productIds[0] },
      });
      await request(app.getHttpServer()).get('/products').expect(200);
      const response = await request(app.getHttpServer())
        .get(`/products/${product.slug}`)
        .expect(200);
      expect(response.body.id).toBe(product.id);
      await request(app.getHttpServer())
        .get(`/products/${randomUUID()}`)
        .expect(404);
    });

    it('creates a pending order, snapshots prices and decrements stock', async () => {
      const response = await request(app.getHttpServer())
        .post('/orders')
        .send(body())
        .expect(201);
      expect(response.body).toMatchObject({ status: 'PENDING', total: 7000 });
      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({
        quantity: 2,
        unitPrice: 3500,
        lineTotal: 7000,
      });
      await prisma.product.update({
        where: { id: productIds[0] },
        data: { price: 4000 },
      });
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: response.body.id },
        include: { items: true },
      });
      expect(order.items[0].unitPrice).toBe(3500);
      expect(
        (
          await prisma.product.findUniqueOrThrow({
            where: { id: productIds[0] },
          })
        ).stock,
      ).toBe(1);
    });

    it('aggregates duplicate product lines before decrementing stock', async () => {
      const response = await request(app.getHttpServer())
        .post('/orders')
        .send(
          body([
            { productId: productIds[0], quantity: 1 },
            { productId: productIds[0], quantity: 2 },
          ]),
        )
        .expect(201);
      expect(response.body.items).toHaveLength(1);
      expect(response.body.total).toBe(10500);
      expect(
        (
          await prisma.product.findUniqueOrThrow({
            where: { id: productIds[0] },
          })
        ).stock,
      ).toBe(0);
    });

    it('rejects invalid quantities and supplied prices', async () => {
      await request(app.getHttpServer())
        .post('/orders')
        .send(body([{ productId: productIds[0], quantity: 0 }]))
        .expect(400);
      await request(app.getHttpServer())
        .post('/orders')
        .send({ ...body(), total: 1 })
        .expect(400);
      expect(await prisma.order.count({ where: { customerEmail } })).toBe(0);
    });

    it('rejects missing and inactive products', async () => {
      await request(app.getHttpServer())
        .post('/orders')
        .send(body([{ productId: 2_147_483_647, quantity: 1 }]))
        .expect(404);
      await prisma.product.update({
        where: { id: productIds[0] },
        data: { active: false },
      });
      await request(app.getHttpServer())
        .post('/orders')
        .send(body())
        .expect(404);
      expect(await prisma.order.count({ where: { customerEmail } })).toBe(0);
    });

    it('rolls back earlier decrements when another product has insufficient stock', async () => {
      await request(app.getHttpServer())
        .post('/orders')
        .send(
          body([
            { productId: productIds[0], quantity: 1 },
            { productId: productIds[1], quantity: 1 },
          ]),
        )
        .expect(409);
      expect(
        (
          await prisma.product.findUniqueOrThrow({
            where: { id: productIds[0] },
          })
        ).stock,
      ).toBe(3);
      expect(await prisma.order.count({ where: { customerEmail } })).toBe(0);
    });

    it('rejects aggregate quantities above 100', async () => {
      await request(app.getHttpServer())
        .post('/orders')
        .send(
          body([
            { productId: productIds[0], quantity: 60 },
            { productId: productIds[0], quantity: 60 },
          ]),
        )
        .expect(400);
    });

    it('rejects a total that would overflow a database integer', async () => {
      await prisma.product.update({
        where: { id: productIds[0] },
        data: { price: 2_147_483_647 },
      });
      await request(app.getHttpServer())
        .post('/orders')
        .send(body())
        .expect(400);
      expect(
        (
          await prisma.product.findUniqueOrThrow({
            where: { id: productIds[0] },
          })
        ).stock,
      ).toBe(3);
    });

    // PGlite serializes connections; use real PostgreSQL to test row contention.
    it.skipIf(process.env.TEST_SERIAL_DATABASE === 'true')(
      'prevents overselling across concurrent orders',
      async () => {
        await prisma.product.update({
          where: { id: productIds[0] },
          data: { stock: 1 },
        });
        const responses = await Promise.all(
          Array.from({ length: 5 }, () =>
            request(app.getHttpServer())
              .post('/orders')
              .send(body([{ productId: productIds[0], quantity: 1 }])),
          ),
        );
        expect(responses.map((response) => response.status).sort()).toEqual([
          201, 409, 409, 409, 409,
        ]);
        expect(
          (
            await prisma.product.findUniqueOrThrow({
              where: { id: productIds[0] },
            })
          ).stock,
        ).toBe(0);
        expect(await prisma.order.count({ where: { customerEmail } })).toBe(1);
      },
    );
  },
);
