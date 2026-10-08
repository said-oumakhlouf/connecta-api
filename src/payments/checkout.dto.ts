import { IsUUID } from 'class-validator';
import { CreateOrderDto } from '../orders/dto/create-order.dto.js';

export class CheckoutDto extends CreateOrderDto {
  @IsUUID('4')
  checkoutKey: string;
}
