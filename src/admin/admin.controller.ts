import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminService } from './admin.service.js';
import { AdminGuard } from './admin.guard.js';
import {
  AdminLoginDto,
  AdminOrdersQueryDto,
  RestockProductDto,
  OrderIdDto,
  UpdateOrderStatusDto,
} from './admin.dto.js';

const validate = (
  expectedType:
    | typeof AdminLoginDto
    | typeof AdminOrdersQueryDto
    | typeof RestockProductDto
    | typeof OrderIdDto
    | typeof UpdateOrderStatusDto,
) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });

@Controller('admin')
export class AdminLoginController {
  constructor(private readonly auth: AdminAuthService) {}

  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  login(
    @Body(validate(AdminLoginDto)) dto: AdminLoginDto,
    @Req() request: Request,
  ) {
    return this.auth.login(dto.password, request.ip ?? 'unknown');
  }
}

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly auth: AdminAuthService,
  ) {}

  @Get('orders')
  @Header('Cache-Control', 'no-store')
  orders(@Query(validate(AdminOrdersQueryDto)) query: AdminOrdersQueryDto) {
    return this.admin.orders(query);
  }

  @Get('products')
  @Header('Cache-Control', 'no-store')
  products() {
    return this.admin.products();
  }

  @Post('orders/:id/status')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  updateOrderStatus(
    @Param(validate(OrderIdDto)) { id }: OrderIdDto,
    @Body(validate(UpdateOrderStatusDto)) dto: UpdateOrderStatusDto,
  ) {
    return this.admin.updateOrderStatus(id, dto.status);
  }

  @Post('products/:id/restock')
  @Header('Cache-Control', 'no-store')
  restock(
    @Param('id', ParseIntPipe) id: number,
    @Body(validate(RestockProductDto)) dto: RestockProductDto,
  ) {
    return this.admin.restock(id, dto.quantity);
  }

  @Post('logout')
  @HttpCode(204)
  logout(@Headers('authorization') authorization?: string) {
    this.auth.logout(authorization);
  }
}
