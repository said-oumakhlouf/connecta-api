import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  ValidationPipe,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { ShippingService } from '../shipping/shipping.service.js';
import { CheckoutDto, ReservationKeyDto } from './checkout.dto.js';
import { PaymentsService } from './payments.service.js';
import { StripeGateway } from './stripe.gateway.js';

const reservationKey = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  expectedType: ReservationKeyDto,
});

@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly stripe: StripeGateway,
    private readonly shipping: ShippingService,
  ) {}

  @Get('shipping')
  @Header('Cache-Control', 'no-store')
  shippingOptions() { return this.shipping.options(); }

  @Post('checkout')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  checkout(
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        expectedType: CheckoutDto,
      }),
    )
    dto: CheckoutDto,
    @Req() req: Request,
  ) {
    return this.payments.checkout(dto, req.ip ?? 'unknown', req.headers.origin);
  }

  // Reservation routes: the random checkoutKey held by the shopper's browser is
  // the only credential. Responses carry amounts and status, never personal data.
  @Post('reservation/status')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  reservationStatus(
    @Body(reservationKey) dto: ReservationKeyDto,
    @Req() req: Request,
  ) {
    return this.payments.reservationStatus(dto.checkoutKey, req.ip ?? 'unknown');
  }

  @Post('reservation/resume')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  resumeReservation(
    @Body(reservationKey) dto: ReservationKeyDto,
    @Req() req: Request,
  ) {
    return this.payments.resumeReservation(
      dto.checkoutKey,
      req.ip ?? 'unknown',
      req.headers.origin,
    );
  }

  @Post('reservation/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  cancelReservation(
    @Body(reservationKey) dto: ReservationKeyDto,
    @Req() req: Request,
  ) {
    return this.payments.cancelReservation(dto.checkoutKey, req.ip ?? 'unknown');
  }

  @Get('checkout/:sessionId')
  @Header('Cache-Control', 'no-store')
  status(@Param('sessionId') id: string) {
    if (!/^cs_test_[a-zA-Z0-9]+$/.test(id))
      throw new BadRequestException('Session invalide');
    return this.payments.status(id);
  }

  @Post('checkout/:sessionId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async cancel(@Param('sessionId') id: string) {
    if (!/^cs_test_[a-zA-Z0-9]+$/.test(id))
      throw new BadRequestException('Session invalide');
    return this.payments.cancelSession(id);
  }

  @Post('webhook')
  @HttpCode(200)
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ) {
    if (!req.rawBody || !signature)
      throw new BadRequestException('Signature absente');
    let event;
    try {
      event = this.stripe.verify(req.rawBody, signature);
    } catch {
      throw new BadRequestException('Signature Stripe invalide');
    }
    return this.payments.event(event);
  }
}
