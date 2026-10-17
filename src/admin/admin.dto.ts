import { Transform, Type } from 'class-transformer';
import {
  ValidateIf,
  IsOptional,
  IsInt,
  IsBoolean,
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

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MaxLength(80)
  search?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value)
  @IsString()
  @Matches(/^[A-Z]$/)
  letter?: string;

  @IsIn(['date_desc', 'name_asc', 'name_desc'])
  sort: 'date_desc' | 'name_asc' | 'name_desc' = 'date_desc';

  @IsIn(['all', 'paid', 'unpaid', 'preparing', 'shipped', 'delivered'])
  filter: 'all' | 'paid' | 'unpaid' | 'preparing' | 'shipped' | 'delivered' = 'all';
}

/** Editable catalogue fields; neither stock nor product ID may be changed here. */
export class UpdateProductDto {
  @ValidateIf((_dto: UpdateProductDto, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  name?: string;

  @ValidateIf((_dto: UpdateProductDto, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  price?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  duoPrice?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^https:\/\/res\.cloudinary\.com\/[a-zA-Z0-9_-]+\/image\/upload\/[a-zA-Z0-9_/.%-]+$/)
  @MaxLength(800)
  imageUrl?: string | null;

  @ValidateIf((_dto: UpdateProductDto, value: unknown) => value !== undefined)
  @IsBoolean()
  active?: boolean;
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
