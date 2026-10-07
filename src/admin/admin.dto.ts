import { Type } from 'class-transformer';
import {
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
