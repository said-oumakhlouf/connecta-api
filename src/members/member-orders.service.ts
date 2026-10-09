import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PaymentsService } from '../payments/payments.service.js';

@Injectable()
export class MemberOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  async list(email: string, page: number) {
    const where = {
      customerEmail: { equals: email, mode: 'insensitive' as const },
    };
    const [orders, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        skip: (page - 1) * 20,
        take: 20,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          customerName: true,
          status: true,
          paymentStatus: true,
          total: true,
          createdAt: true,
          reservedUntil: true,
          paidAt: true,
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
      this.prisma.order.count({ where }),
    ]);
    return { orders, total, page, limit: 20 };
  }

  private async owned(email: string, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, customerEmail: { equals: email, mode: 'insensitive' } },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Commande introuvable.');
    return order;
  }

  async resume(email: string, id: string, ip: string) {
    const order = await this.owned(email, id);
    if (order.paymentStatus !== 'UNPAID' || !order.checkoutKey)
      throw new ConflictException('Cette commande ne peut plus être payée.');
    return this.payments.checkout(
      {
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        items: order.items.map(({ productId, quantity }) => ({
          productId,
          quantity,
        })),
        checkoutKey: order.checkoutKey,
      },
      ip,
    );
  }

  async cancel(email: string, id: string) {
    const order = await this.owned(email, id);
    if (!['UNPAID', 'EXPIRED'].includes(order.paymentStatus))
      throw new ConflictException(
        'Cette commande ne peut pas être annulée ici. Contactez-nous.',
      );
    await this.payments.cancel(order.id);
  }
}
