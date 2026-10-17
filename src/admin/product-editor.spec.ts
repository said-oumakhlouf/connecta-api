import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AdminService } from './admin.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { PaymentsService } from '../payments/payments.service.js';

describe('Admin product editor', () => {
  const current = {
    id: 1, name: 'Hoco EW75', slug: 'hoco-ew75',
    price: 3500, duoPrice: 6000, stock: 20, active: true,
    description: null, imageUrl: null,
  };
  const findUnique = vi.fn();
  const update = vi.fn();
  const service = new AdminService(
    { product: { findUnique, update } } as unknown as PrismaService,
    {} as PaymentsService,
  );

  beforeEach(() => {
    findUnique.mockReset().mockResolvedValue(current);
    update.mockReset().mockResolvedValue({ ...current, price: 3900 });
  });

  it('persists only editable fields without changing stock or slug', async () => {
    const dto = { name: 'Nouveau nom', price: 3900, description: 'Description vérifiée', active: false };
    await service.updateProduct(1, dto);
    expect(update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: dto,
      select: expect.objectContaining({ description: true, imageUrl: true }),
    });
  });

  it('rejects invalid Duo pricing', async () => {
    await expect(service.updateProduct(1, { price: 2000 })).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects unknown product', async () => {
    findUnique.mockResolvedValue(null);
    await expect(service.updateProduct(404, { price: 4000 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses an image hosted under a different Cloudinary account', async () => {
    const previous = process.env.CLOUDINARY_CLOUD_NAME;
    process.env.CLOUDINARY_CLOUD_NAME = 'connecta';
    try {
      await expect(service.updateProduct(1, {
        imageUrl: 'https://res.cloudinary.com/stranger/image/upload/example.jpg',
      })).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      if (previous === undefined) delete process.env.CLOUDINARY_CLOUD_NAME;
      else process.env.CLOUDINARY_CLOUD_NAME = previous;
    }
  });

  it('requires configured Cloudinary keys to sign direct uploads', () => {
    const previous = [
      process.env.CLOUDINARY_CLOUD_NAME,
      process.env.CLOUDINARY_API_KEY,
      process.env.CLOUDINARY_API_SECRET,
    ];
    delete process.env.CLOUDINARY_CLOUD_NAME;
    delete process.env.CLOUDINARY_API_KEY;
    delete process.env.CLOUDINARY_API_SECRET;
    try {
      expect(() => service.uploadSignature()).toThrow(ServiceUnavailableException);
      process.env.CLOUDINARY_CLOUD_NAME = 'connecta';
      process.env.CLOUDINARY_API_KEY = 'publickey';
      process.env.CLOUDINARY_API_SECRET = 'test-only-secret';
      const signed = service.uploadSignature();
      const expected = createHash('sha1')
        .update(`folder=${signed.folder}&timestamp=${signed.timestamp}test-only-secret`)
        .digest('hex');
      expect(signed).toMatchObject({ cloudName: 'connecta', apiKey: 'publickey', signature: expected });
      expect(JSON.stringify(signed)).not.toContain('test-only-secret');
    } finally {
      for (const [index, name] of [
        'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET',
      ].entries()) {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      }
    }
  });
});
