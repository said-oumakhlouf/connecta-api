import { createHash } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  HttpException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { StripeGateway } from './stripe.gateway.js';
import type { CheckoutDto } from './checkout.dto.js';
import type { Order } from '../generated/prisma/client.js';

@Injectable()
export class PaymentsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private sweepCursor: string | undefined;
  private readonly logger = new Logger(PaymentsService.name);
  private readonly attempts = new Map<
    string,
    { count: number; until: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly stripe: StripeGateway,
  ) {}

  async onModuleInit() {
    if (!this.stripe.client) return;
    await this.sweep();
    this.timer = setInterval(() => void this.sweep(), 30000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async checkout(dto: CheckoutDto, ip: string) {
    const client = this.stripe.requireClient();
    const quantities = new Map<number, number>();
    for (const item of dto.items)
      quantities.set(
        item.productId,
        (quantities.get(item.productId) ?? 0) + item.quantity,
      );
    const normalized = {
      customerName: dto.customerName.trim(),
      customerEmail: dto.customerEmail.trim().toLowerCase(),
      items: [...quantities]
        .sort((a, b) => a[0] - b[0])
        .map(([productId, quantity]) => ({ productId, quantity })),
    };
    const checkoutFingerprint = createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex');
    let order = await this.prisma.order.findUnique({
      where: { checkoutKey: dto.checkoutKey },
      include: { items: true },
    });
    if (!order) {
      this.limit(ip);
      try {
        order = await this.orders.create(normalized, {
          checkoutKey: dto.checkoutKey,
          checkoutFingerprint,
          checkoutIpHash: createHash('sha256').update(ip).digest('hex'),
          reservedUntil: new Date(Date.now() + 31 * 60 * 1000),
        });
      } catch (error) {
        // A duplicate key rolls back the entire competing stock reservation.
        const existing = await this.prisma.order.findUnique({
          where: { checkoutKey: dto.checkoutKey },
          include: { items: true },
        });
        if (!existing) throw error;
        order = existing;
      }
    }
    if (order.checkoutFingerprint !== checkoutFingerprint)
      throw new ConflictException(
        'Cette tentative correspond à un autre panier',
      );
    if (
      order.paymentStatus !== 'UNPAID' ||
      !order.reservedUntil ||
      order.reservedUntil.getTime() <= Date.now()
    ) {
      throw new ConflictException(
        'Cette réservation est terminée. Actualisez le panier',
      );
    }
    let session: Stripe.Checkout.Session;
    try {
      session = order.checkoutSessionId
        ? await client.checkout.sessions.retrieve(order.checkoutSessionId)
        : await client.checkout.sessions.create(
            {
              mode: 'payment',
              allowed_payment_method_types: ['card'],
              locale: 'fr',
              customer_email: order.customerEmail,
              client_reference_id: order.id,
              metadata: { orderId: order.id },
              expires_at: Math.floor(order.reservedUntil.getTime() / 1000),
              success_url: `${this.stripe.origin.replace(/\/$/, '')}/paiement?session_id={CHECKOUT_SESSION_ID}`,
              cancel_url: `${this.stripe.origin.replace(/\/$/, '')}/paiement?retour=1`,
              shipping_address_collection: { allowed_countries: ['FR'] },
              line_items: order.items.map((item) => ({
                quantity: 1,
                price_data: {
                  currency: 'eur',
                  unit_amount: item.lineTotal,
                  product_data: {
                    name: `${item.productName} · ${item.quantity} unité(s)`,
                  },
                },
              })),
            },
            { idempotencyKey: `connecta-checkout-${order.checkoutKey}` },
          );
    } catch (error) {
      // Never free a linked session on a network error: Stripe might have accepted payment.
      if (
        !order.checkoutSessionId &&
        error instanceof Stripe.errors.StripeInvalidRequestError
      ) {
        await this.release(order.id, null);
      }
      throw new ServiceUnavailableException(
        'Paiement indisponible. Réessayez le même panier pour reprendre la réservation',
      );
    }
    this.validateSession(session, order);
    if (session.status !== 'open' || !session.url) {
      await this.applySession(session, order);
      throw new ConflictException('Cette réservation est terminée');
    }
    const linked = await this.prisma.order.updateMany({
      where: {
        id: order.id,
        paymentStatus: 'UNPAID',
        reservedUntil: { gt: new Date() },
        OR: [{ checkoutSessionId: null }, { checkoutSessionId: session.id }],
      },
      data: { checkoutSessionId: session.id },
    });
    if (!linked.count) {
      await client.checkout.sessions.expire(session.id).catch(() => undefined);
      throw new ConflictException('Réservation expirée');
    }
    return {
      sessionId: session.id,
      url: session.url,
      expiresAt: new Date(session.expires_at * 1000).toISOString(),
      total: order.total,
      testMode: true,
    };
  }

  private limit(ip: string) {
    const now = Date.now();
    for (const [key, value] of this.attempts)
      if (value.until <= now) this.attempts.delete(key);
    const value = this.attempts.get(ip) ?? {
      count: 0,
      until: now + 15 * 60 * 1000,
    };
    if (
      value.count >= 10 ||
      (!this.attempts.has(ip) && this.attempts.size >= 5000)
    )
      throw new HttpException(
        'Trop de réservations. Patientez avant de recommencer',
        429,
      );
    value.count++;
    this.attempts.set(ip, value);
  }

  private validateSession(session: Stripe.Checkout.Session, order: Order) {
    if (
      session.livemode ||
      session.mode !== 'payment' ||
      session.currency !== 'eur' ||
      session.amount_total !== order.total ||
      session.metadata?.orderId !== order.id ||
      session.client_reference_id !== order.id ||
      (order.checkoutSessionId && order.checkoutSessionId !== session.id)
    ) {
      throw new ConflictException(
        'Le paiement Stripe ne correspond pas à la commande',
      );
    }
  }

  async applySession(session: Stripe.Checkout.Session, order: Order) {
    this.validateSession(session, order);
    if (session.status === 'complete' && session.payment_status === 'paid') {
      if (order.paymentStatus === 'EXPIRED')
        throw new ConflictException(
          'Paiement reçu pour une réservation terminée : vérification nécessaire',
        );
      const changed = await this.prisma.order.updateMany({
        where: { id: order.id, paymentStatus: 'UNPAID' },
        data: {
          checkoutSessionId: session.id,
          paymentStatus: 'PAID',
          status: 'CONFIRMED',
          paidAt: new Date(),
        },
      });
      if (!changed.count) {
        const current = await this.prisma.order.findUniqueOrThrow({
          where: { id: order.id },
        });
        if (current.paymentStatus !== 'PAID')
          throw new ConflictException(
            'Paiement reçu pour une réservation terminée : vérification nécessaire',
          );
      }
    } else if (
      session.status === 'expired' &&
      session.payment_status !== 'paid'
    ) {
      await this.release(order.id, order.checkoutSessionId);
    }
  }

  async release(orderId: string, sessionId: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.order.updateMany({
        where: {
          id: orderId,
          paymentStatus: 'UNPAID',
          checkoutSessionId: sessionId,
        },
        data: { paymentStatus: 'EXPIRED', status: 'CANCELLED' },
      });
      if (!changed.count) return;
      const items = await tx.orderItem.findMany({
        where: { orderId },
        orderBy: { productId: 'asc' },
      });
      for (const item of items) {
        const restored = await tx.product.updateMany({
          where: {
            id: item.productId,
            stock: { lte: 2147483647 - item.quantity },
          },
          data: { stock: { increment: item.quantity } },
        });
        if (restored.count !== 1)
          throw new ConflictException('Stock maximum dépassé');
      }
    });
  }

  async status(sessionId: string) {
    let order = await this.prisma.order.findUnique({
      where: { checkoutSessionId: sessionId },
    });
    if (!order) throw new NotFoundException('Réservation introuvable');
    if (order.paymentStatus === 'UNPAID')
      await this.applySession(
        await this.stripe.requireClient().checkout.sessions.retrieve(sessionId),
        order,
      );
    order = await this.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    return {
      orderId: order.id,
      total: order.total,
      paymentStatus: order.paymentStatus,
      expiresAt: order.reservedUntil?.toISOString(),
      testMode: true,
    };
  }

  async cancel(orderId: string) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    if (order.paymentStatus === 'EXPIRED') return;
    if (order.paymentStatus !== 'UNPAID')
      throw new ConflictException(
        'Commande payée : un remboursement est nécessaire',
      );
    if (!order.checkoutSessionId) {
      // No checkout URL was ever returned to the client until the session was linked.
      await this.release(order.id, null);
      return;
    }
    const client = this.stripe.requireClient();
    let session = await client.checkout.sessions.retrieve(
      order.checkoutSessionId,
    );
    if (session.status === 'open') {
      try {
        session = await client.checkout.sessions.expire(session.id);
      } catch {
        session = await client.checkout.sessions.retrieve(session.id);
      }
    }
    await this.applySession(session, order);
    if (session.status !== 'expired')
      throw new ConflictException(
        'Paiement terminé ou en cours : réservation conservée',
      );
  }

  async cancelSession(sessionId: string) {
    const order = await this.prisma.order.findUnique({
      where: { checkoutSessionId: sessionId },
    });
    if (!order) throw new NotFoundException('Réservation introuvable');
    await this.cancel(order.id);
    return this.status(sessionId);
  }

  async event(event: Stripe.Event) {
    if (event.livemode)
      throw new ConflictException('Événement réel refusé en mode test');
    if (
      [
        'checkout.session.completed',
        'checkout.session.expired',
        'checkout.session.async_payment_succeeded',
      ].includes(event.type)
    ) {
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = session.metadata?.orderId;
      if (orderId) {
        const order = await this.prisma.order.findUnique({
          where: { id: orderId },
        });
        if (!order) throw new NotFoundException('Commande Stripe introuvable');
        // Fetch current Stripe state rather than trust delivery order of events.
        await this.applySession(
          await this.stripe
            .requireClient()
            .checkout.sessions.retrieve(session.id),
          order,
        );
      }
    }
    return { received: true };
  }

  async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const orders = await this.prisma.order.findMany({
        where: {
          paymentStatus: 'UNPAID',
          reservedUntil: { lte: new Date() },
          ...(this.sweepCursor ? { id: { gt: this.sweepCursor } } : {}),
        },
        take: 20,
        orderBy: { id: 'asc' },
      });
      // Rotate across batches so failed reservations cannot starve later ones.
      this.sweepCursor = orders.length === 20 ? orders.at(-1)?.id : undefined;
      for (const order of orders) {
        try {
          await this.cancel(order.id);
        } catch {
          this.logger.warn(
            `Réservation ${order.id} à vérifier ; stock conservé`,
          );
        }
      }
    } catch {
      this.logger.warn('Vérification des réservations indisponible');
    } finally {
      this.sweeping = false;
    }
  }
}
