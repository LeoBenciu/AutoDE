import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
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

class UpdateContractTemplatesDto {
  @IsOptional()
  @IsString()
  @MaxLength(30_000)
  sale?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30_000)
  handover?: string;
}

class PreviewContractTemplateDto {
  @IsEnum(['vanzare-cumparare', 'proces-verbal'])
  kind: 'vanzare-cumparare' | 'proces-verbal';

  @IsOptional()
  @IsString()
  @MaxLength(30_000)
  template?: string;
}

@Controller('contracts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get('templates')
  templates(@CurrentUser() user: AuthUser) {
    return this.contracts.templates(user.tenantId);
  }

  @Patch('templates')
  @Roles('ACCOUNTANT')
  updateTemplates(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateContractTemplatesDto,
  ) {
    return this.contracts.updateTemplates(user.tenantId, user.userId, dto);
  }

  @Post('templates/preview')
  @Roles('ACCOUNTANT')
  previewTemplate(@Body() dto: PreviewContractTemplateDto) {
    return this.contracts.previewTemplate(dto.kind, dto.template);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('vehicleId') vehicleId?: string) {
    return this.contracts.list(user.tenantId, vehicleId ? Number(vehicleId) : undefined);
  }

  @Post('generate')
  @Roles('ACCOUNTANT', 'SALES')
  generate(@CurrentUser() user: AuthUser, @Body() dto: GenerateContractDto) {
    return this.contracts.generate(user.tenantId, user.userId, dto);
  }

  @Post(':id/regenerate')
  @Roles('ACCOUNTANT', 'SALES')
  regenerate(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.contracts.regenerate(user.tenantId, user.userId, id);
  }
}
