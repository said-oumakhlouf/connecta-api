import { Transform, Type } from 'class-transformer';
import {
  ValidateIf,
  IsInt,
  IsIn,
  IsUUID,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  Matches,
} from 'class-validator';

export class AdminLoginDto {
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password: string;
}

export class AdminOrdersQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export class RestockProductDto {
  @IsInt()
  @Min(1)
  @Max(10000)
  quantity: number;
}

export class OrderIdDto {
  @IsUUID()
  id: string;
}

export class UpdateOrderStatusDto {
  @IsIn(['CONFIRMED', 'CANCELLED'])
  status: 'CONFIRMED' | 'CANCELLED';
}

export class AdminAnalyticsQueryDto {
  @IsString()
  @Matches(/^20\d{2}-(0[1-9]|1[0-2])$/)
  month: string;
}

export class UpdateFulfillmentDto {
  @IsIn(['PREPARING', 'SHIPPED', 'DELIVERED'])
  status: 'PREPARING' | 'SHIPPED' | 'DELIVERED';

  @ValidateIf((dto: UpdateFulfillmentDto) => dto.status === 'SHIPPED' || dto.trackingCarrier !== undefined)
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  trackingCarrier?: string;

  @ValidateIf((dto: UpdateFulfillmentDto) => dto.status === 'SHIPPED' || dto.trackingNumber !== undefined)
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9 -]{2,79}$/)
  trackingNumber?: string;
}
