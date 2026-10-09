import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class MemberLoginDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;
}

export class MemberVerifyDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  token: string;
}

export class MemberOrdersDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  page = 1;
}

export class MemberOrderIdDto {
  @IsUUID()
  id: string;
}
