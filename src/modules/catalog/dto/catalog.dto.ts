import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PartnerType } from '@prisma/client';

/**
 * `code` is no longer accepted on create — it is issued by
 * CodeGeneratorService so two people saving at once cannot collide, and so
 * the forms have one less field to get wrong. It stays here only to keep an
 * older client from being rejected outright; the value is ignored.
 */
class LegacyCode {
  @ApiPropertyOptional({ deprecated: true, description: 'ບໍ່ໃຊ້ແລ້ວ — ລະຫັດອອກອັດຕະໂນມັດ' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  code?: string;
}

export class CreateGoldTypeDto extends LegacyCode {
  @IsString() @MinLength(1) @MaxLength(80) nameLo: string;
  @IsOptional() @IsBoolean() isStockType?: boolean;
}

export class CreateGoldItemDto extends LegacyCode {
  @IsString() @MinLength(1) @MaxLength(80) nameLo: string;
}

export class CreateCabinetDto extends LegacyCode {
  @IsString() @MinLength(1) @MaxLength(80) nameLo: string;
}

export class CreatePartnerDto extends LegacyCode {
  @IsString() @MinLength(1) @MaxLength(80) nameLo: string;
  @IsIn(['IN', 'OUT', 'BOTH']) direction: 'IN' | 'OUT' | 'BOTH';
  @IsOptional() @IsIn(['FACTORY', 'SMITH', 'SUPPLIER', 'INTERNAL']) type?: PartnerType;
  @IsOptional() @IsBoolean() tracksGoldApAr?: boolean;
}

/**
 * Updates never touch `code`. An issued code may already be printed on a
 * receipt or quoted in a ledger row, so it is the one field that has to stay
 * put once the row exists.
 */
export class UpdateGoldTypeDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) nameLo?: string;
  @IsOptional() @IsBoolean() isStockType?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateGoldItemDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) nameLo?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateCabinetDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) nameLo?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdatePartnerDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) nameLo?: string;
  @IsOptional() @IsIn(['IN', 'OUT', 'BOTH']) direction?: 'IN' | 'OUT' | 'BOTH';
  @IsOptional() @IsIn(['FACTORY', 'SMITH', 'SUPPLIER', 'INTERNAL']) type?: PartnerType;
  @IsOptional() @IsBoolean() tracksGoldApAr?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateBranchDto extends LegacyCode {
  @IsString()
  @MinLength(1, { message: 'ກະລຸນາປ້ອນຊື່ສັງກັດ / ສາຂາ' })
  @MaxLength(80, { message: 'ຊື່ສັງກັດ / ສາຂາຍາວເກີນ 80 ຕົວ' })
  nameLo: string;
}

export class UpdateBranchDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'ກະລຸນາປ້ອນຊື່ສັງກັດ / ສາຂາ' })
  @MaxLength(80, { message: 'ຊື່ສັງກັດ / ສາຂາຍາວເກີນ 80 ຕົວ' })
  nameLo?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateEmployeeDto extends LegacyCode {
  @IsString()
  @MinLength(1, { message: 'ກະລຸນາປ້ອນຊື່ພະນັກງານ' })
  @MaxLength(80, { message: 'ຊື່ພະນັກງານຍາວເກີນ 80 ຕົວ' })
  fullName: string;

  @IsOptional()
  @IsString()
  @Matches(/^(\d{8})?$/, { message: 'ເບີໂທຕ້ອງເປັນຕົວເລກ 8 ໂຕ' })
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80, { message: 'ຕຳແໜ່ງຍາວເກີນ 80 ຕົວ' })
  position?: string;

  @IsOptional()
  @IsString()
  branchId?: string | null;
}

export class UpdateEmployeeDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'ກະລຸນາປ້ອນຊື່ພະນັກງານ' })
  @MaxLength(80, { message: 'ຊື່ພະນັກງານຍາວເກີນ 80 ຕົວ' })
  fullName?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(\d{8})?$/, { message: 'ເບີໂທຕ້ອງເປັນຕົວເລກ 8 ໂຕ' })
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80, { message: 'ຕຳແໜ່ງຍາວເກີນ 80 ຕົວ' })
  position?: string;

  @IsOptional()
  @IsString()
  branchId?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
