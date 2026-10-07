import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AdminOrdersQueryDto } from './admin.dto.js';

const productSelect = {
  id: true,
  name: true,
  slug: true,
  price: true,
  duoPrice: true,
  stock: true,
  active: true,
} as const;

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async orders({ page, limit }: AdminOrdersQueryDto) {
    const [orders, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          customerName: true,
          customerEmail: true,
          status: true,
          total: true,
          createdAt: true,
          items: {
            select: {
              productId: true,
              productName: true,
              quantity: true,
              unitPrice: true,
              discount: true,
              lineTotal: true,
            },
            orderBy: { id: 'asc' },
          },
        },
      }),
      this.prisma.order.count(),
    ]);
    return { orders, total, page, limit };
  }

  products() {
    return this.prisma.product.findMany({
      orderBy: { id: 'asc' },
      select: productSelect,
    });
  }

  restock(id: number, quantity: number) {
    if (id < 1 || id > 2_147_483_647) {
      throw new BadRequestException('Identifiant produit invalide');
    }
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.product.updateMany({
        where: { id, stock: { lte: 2_147_483_647 - quantity } },
        data: { stock: { increment: quantity } },
      });
      if (!result.count) {
        const product = await tx.product.findUnique({
          where: { id },
          select: { id: true },
        });
        if (!product) throw new NotFoundException('Produit introuvable');
        throw new ConflictException('La quantité dépasserait le stock maximum');
      }
      return tx.product.findUniqueOrThrow({
        where: { id },
        select: productSelect,
      });
    });
  }
}
