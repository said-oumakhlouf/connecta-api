import {
  Body,
  Controller,
  Post,
  ValidationPipe,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CreateOrderDto } from './dto/create-order.dto.js';
import { OrdersService } from './orders.service.js';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly config: ConfigService,
  ) {}

  @Post()
  create(
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        expectedType: CreateOrderDto,
      }),
    )
    dto: CreateOrderDto,
  ) {
    if (
      this.config.get('STRIPE_SECRET_KEY') ||
      process.env.NODE_ENV === 'production'
    ) {
      throw new ServiceUnavailableException(
        'Utilisez le paiement sécurisé pour commander',
      );
    }
    return this.ordersService.create(dto);
  }
}
