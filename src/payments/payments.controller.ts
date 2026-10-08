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
import { CheckoutDto } from './checkout.dto.js';
import { PaymentsService } from './payments.service.js';
import { StripeGateway } from './stripe.gateway.js';

@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly stripe: StripeGateway,
  ) {}

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
    return this.payments.checkout(dto, req.ip ?? 'unknown');
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
