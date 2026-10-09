import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  HttpException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { Prisma } from '../generated/prisma/client.js';
import { calculateLinePrice } from './order-pricing.js';

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    dto: CreateOrderDto,
    checkout?: {
      checkoutKey: string;
      checkoutFingerprint: string;
      reservedUntil: Date;
      checkoutIpHash: string;
    },
  ) {
    // Merge duplicate lines before checking stock and lock products in ID order.
    const quantities = new Map<number, number>();
    for (const item of dto.items) {
      const quantity = (quantities.get(item.productId) ?? 0) + item.quantity;
      if (quantity > 10) {
        throw new BadRequestException('Maximum 10 unités par commande');
      }
      quantities.set(item.productId, quantity);
    }
    if (
      [...quantities.values()].reduce((sum, quantity) => sum + quantity, 0) > 10
    )
      throw new BadRequestException('Maximum 10 unités par commande');
    const customerEmail = dto.customerEmail.trim().toLowerCase();
    const productIds = [...quantities.keys()].sort((a, b) => a - b);

    const reserve = () =>
      this.prisma.$transaction(
        async (tx) => {
          if (checkout) {
            // These predicate reads and the stock reservation commit together.
            // Serializable isolation prevents parallel requests from bypassing limits.
            const pending = await tx.order.findFirst({
              where: {
                customerEmail: { equals: customerEmail, mode: 'insensitive' },
                paymentStatus: 'UNPAID',
              },
              select: { id: true },
            });
            if (pending)
              throw new ConflictException({
                code: 'ACTIVE_RESERVATION',
                message:
                  'Une réservation non payée existe déjà pour cet email. Payez-la ou annulez-la avant de recommencer.',
              });
            const recent = await tx.order.count({
              where: {
                checkoutIpHash: checkout.checkoutIpHash,
                paymentStatus: { in: ['UNPAID', 'EXPIRED'] },
                createdAt: { gte: new Date(Date.now() - 31 * 60 * 1000) },
              },
            });
            if (recent >= 3)
              throw new HttpException(
                {
                  code: 'RESERVATION_RATE_LIMIT',
                  message:
                    'Maximum 3 réservations non payées ou annulées en 31 minutes depuis cette connexion.',
                },
                429,
              );
          }
          const products = await tx.product.findMany({
            where: { id: { in: productIds }, active: true },
            orderBy: { id: 'asc' },
          });

          if (products.length !== productIds.length) {
            throw new NotFoundException(
              'Un produit est introuvable ou inactif',
            );
          }

          const items = products.map((product) => {
            const quantity = quantities.get(product.id)!;
            return {
              productId: product.id,
              productName: product.name,
              quantity,
              unitPrice: product.price,
              ...calculateLinePrice(product.price, quantity, product.duoPrice),
            };
          });
          const total = items.reduce((sum, item) => sum + item.lineTotal, 0);
          if (
            items.some(
              (item) =>
                item.unitPrice < 0 ||
                item.lineTotal < 0 ||
                item.discount > 2_147_483_647,
            ) ||
            total > 2_147_483_647
          ) {
            throw new BadRequestException('Montant de commande invalide');
          }

          for (const [index, item] of items.entries()) {
            // The stock condition is evaluated by PostgreSQL during the UPDATE,
            // including when another order is waiting on the same row.
            const result = await tx.product.updateMany({
              where: {
                id: item.productId,
                active: true,
                price: item.unitPrice,
                duoPrice: products[index].duoPrice,
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
              customerEmail,
              total,
              ...(checkout
                ? { ...checkout, paymentStatus: 'UNPAID' as const }
                : {}),
              items: { create: items },
            },
            include: { items: true },
          });
        },
        { isolationLevel: checkout ? 'Serializable' : 'ReadCommitted' },
      );
    for (let attempt = 0; ; attempt++) {
      try {
        return await reserve();
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== 'P2034'
        )
          throw error;
        if (attempt >= 4)
          throw new ConflictException(
            'Réservations simultanées : réessayez le même panier.',
          );
      }
    }
  }
}
