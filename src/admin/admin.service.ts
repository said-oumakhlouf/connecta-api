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

const orderSelect = {
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
        select: orderSelect,
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

  updateOrderStatus(id: string, status: 'CONFIRMED' | 'CANCELLED') {
    return this.prisma.$transaction(async (tx) => {
      // Lock the order through a conditional UPDATE before restoring any stock.
      // Repeating the same action is safe, including after a lost HTTP response.
      const changed = await tx.order.updateMany({
        where: {
          id,
          status:
            status === 'CONFIRMED'
              ? 'PENDING'
              : { in: ['PENDING', 'CONFIRMED'] },
        },
        data: { status },
      });
      const order = await tx.order.findUnique({
        where: { id },
        select: orderSelect,
      });
      if (!order) throw new NotFoundException('Commande introuvable');
      if (!changed.count) {
        if (order.status === status) return order;
        throw new ConflictException(
          'Une commande annulée ne peut pas être confirmée',
        );
      }
      if (status === 'CANCELLED') {
        for (const item of [...order.items].sort(
          (a, b) => a.productId - b.productId,
        )) {
          const restored = await tx.product.updateMany({
            where: {
              id: item.productId,
              stock: { lte: 2_147_483_647 - item.quantity },
            },
            data: { stock: { increment: item.quantity } },
          });
          if (restored.count !== 1) {
            throw new ConflictException(
              'Le stock maximum empêcherait l’annulation',
            );
          }
        }
      }
      return order;
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
