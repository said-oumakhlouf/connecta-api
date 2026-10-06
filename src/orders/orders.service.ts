import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateOrderDto) {
    // Merge duplicate lines before checking stock and lock products in ID order.
    const quantities = new Map<number, number>();
    for (const item of dto.items) {
      const quantity = (quantities.get(item.productId) ?? 0) + item.quantity;
      if (quantity > 100) {
        throw new BadRequestException('Maximum 100 unités par produit');
      }
      quantities.set(item.productId, quantity);
    }
    const productIds = [...quantities.keys()].sort((a, b) => a - b);

    return this.prisma.$transaction(async (tx) => {
      const products = await tx.product.findMany({
        where: { id: { in: productIds }, active: true },
        orderBy: { id: 'asc' },
      });

      if (products.length !== productIds.length) {
        throw new NotFoundException('Un produit est introuvable ou inactif');
      }

      const items = products.map((product) => {
        const quantity = quantities.get(product.id)!;
        return {
          productId: product.id,
          productName: product.name,
          quantity,
          unitPrice: product.price,
          lineTotal: product.price * quantity,
        };
      });
      const total = items.reduce((sum, item) => sum + item.lineTotal, 0);
      if (items.some((item) => item.unitPrice < 0) || total > 2_147_483_647) {
        throw new BadRequestException('Montant de commande invalide');
      }

      for (const item of items) {
        // The stock condition is evaluated by PostgreSQL during the UPDATE,
        // including when another order is waiting on the same row.
        const result = await tx.product.updateMany({
          where: {
            id: item.productId,
            active: true,
            price: item.unitPrice,
            stock: { gte: item.quantity },
          },
          data: { stock: { decrement: item.quantity } },
        });
        if (result.count !== 1) {
          throw new ConflictException(
            `Stock insuffisant ou produit modifié : ${item.productName}`,
          );
        }
      }

      return tx.order.create({
        data: {
          customerName: dto.customerName,
          customerEmail: dto.customerEmail,
          total,
          items: { create: items },
        },
        include: { items: true },
      });
    });
  }
}
