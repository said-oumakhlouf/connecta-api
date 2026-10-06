import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.product.findMany({
      where: {
        active: true,
      },
    });
  }

  async findBySlug(slug: string) {
    const product = await this.prisma.product.findFirst({
      where: {
        slug,
        active: true,
      },
    });

    if (!product) {
      throw new NotFoundException('Produit introuvable');
    }

    return product;
  }
}
