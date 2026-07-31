import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IsEnum, IsInt, IsNumber, IsOptional, IsString } from 'class-validator';
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { AuthUser } from '../auth/jwt.strategy';
import { ContractsService } from './contracts.service';

class GenerateContractDto {
  @IsInt()
  vehicleId: number;

  @IsInt()
  buyerId: number;

  @IsEnum(['vanzare-cumparare', 'proces-verbal'])
  kind: 'vanzare-cumparare' | 'proces-verbal';

  @IsOptional()
  @IsNumber()
  price?: number;

  @IsOptional()
  @IsString()
  currency?: string;
}

@Controller('contracts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('vehicleId') vehicleId?: string) {
    return this.contracts.list(user.tenantId, vehicleId ? Number(vehicleId) : undefined);
  }

  @Post('generate')
  @Roles('ACCOUNTANT', 'SALES')
  generate(@CurrentUser() user: AuthUser, @Body() dto: GenerateContractDto) {
    return this.contracts.generate(user.tenantId, user.userId, dto);
  }
}
