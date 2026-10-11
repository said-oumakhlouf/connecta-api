import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ShippingAddressDto } from '../shipping/shipping.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PaymentsService } from '../payments/payments.service.js';

@Injectable()
export class MemberOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  /** Checkout details from the latest paid order belonging to the verified email. */
  async customerDetails(email: string) {
    const order = await this.prisma.order.findFirst({
      where: {
        customerEmail: { equals: email, mode: 'insensitive' },
        paymentStatus: 'PAID',
      },
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
      select: { customerName: true, shippingAddress: true },
    });
    return {
      customerName: order?.customerName ?? null,
      shippingAddress: order?.shippingAddress ?? null,
    };
  }

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
          shippingAddress: true,
          shippingFee: true,
          fulfillmentStatus: true,
          trackingCarrier: true,
          trackingNumber: true,
          shippedAt: true,
          deliveredAt: true,
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
        // Old reservations keep their original fingerprint and amount.
        shippingAddress: order.shippingAddress as unknown as ShippingAddressDto,
        expectedShippingFee: order.shippingFee,
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
