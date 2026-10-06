import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductsService } from './products.service.js';

describe('ProductsService', () => {
  const product = { id: 1, slug: 'hoco-ew75', active: true };
  let prisma: {
    product: {
      findMany: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
    };
  };
  let service: ProductsService;

  beforeEach(() => {
    prisma = { product: { findMany: vi.fn(), findFirst: vi.fn() } };
    service = new ProductsService(prisma as unknown as PrismaService);
  });

  it('lists active products', async () => {
    prisma.product.findMany.mockResolvedValue([product]);
    expect(await service.findAll()).toEqual([product]);
    expect(prisma.product.findMany).toHaveBeenCalledWith({
      where: { active: true },
    });
  });

  it('finds an active product by slug', async () => {
    prisma.product.findFirst.mockResolvedValue(product);
    expect(await service.findBySlug(product.slug)).toEqual(product);
    expect(prisma.product.findFirst).toHaveBeenCalledWith({
      where: { slug: product.slug, active: true },
    });
  });

  it('returns 404 for a missing or inactive product', async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    await expect(service.findBySlug('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
