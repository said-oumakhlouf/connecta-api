import { Transform } from 'class-transformer';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ShippingAddressDto {
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  line1: string;

  @Transform(trim)
  @IsString()
  @MaxLength(160)
  line2 = '';

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  city: string;

  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(12)
  postalCode: string;

  @Transform(trim)
  @IsString()
  @MaxLength(2)
  region = '';

  @IsIn(['FR', 'BE', 'CA'])
  country: 'FR' | 'BE' | 'CA';
}
