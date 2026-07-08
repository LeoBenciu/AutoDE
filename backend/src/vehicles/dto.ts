import { IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, Length, Min } from 'class-validator';

export const VEHICLE_STATUSES = [
  'SOURCED',
  'PURCHASED',
  'IN_TRANSIT',
  'CUSTOMS',
  'IN_STOCK',
  'RESERVED',
  'SOLD',
  'DELIVERED',
] as const;

export class CreateVehicleDto {
  @IsString()
  @Length(11, 17)
  vin: string;

  @IsString()
  make: string;

  @IsString()
  model: string;

  @IsOptional()
  @IsString()
  variant?: string;

  @IsInt()
  @Min(1980)
  year: number;

  @IsOptional()
  @IsDateString()
  firstRegistered?: string;

  @IsOptional()
  @IsInt()
  mileageKm?: number;

  @IsOptional()
  @IsString()
  fuelType?: string;

  @IsOptional()
  @IsString()
  gearbox?: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsString()
  originCountry?: string;

  @IsNumber()
  purchasePrice: number;

  @IsOptional()
  @IsString()
  purchaseCurrency?: string;

  @IsOptional()
  @IsNumber()
  listPrice?: number;

  @IsOptional()
  @IsInt()
  sellerId?: number;
}

export class UpdateVehicleDto {
  @IsOptional()
  @IsEnum(VEHICLE_STATUSES)
  status?: (typeof VEHICLE_STATUSES)[number];

  @IsOptional()
  @IsNumber()
  listPrice?: number;

  @IsOptional()
  @IsNumber()
  soldPrice?: number;

  @IsOptional()
  @IsInt()
  buyerId?: number;

  @IsOptional()
  @IsInt()
  mileageKm?: number;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsString()
  variant?: string;
}

export class AddCostDto {
  @IsEnum(['PURCHASE', 'TRANSPORT', 'CUSTOMS', 'VAT', 'ITP', 'REGISTRATION', 'REFURB', 'OTHER'])
  category: string;

  @IsNumber()
  amount: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsInt()
  documentId?: number;
}
