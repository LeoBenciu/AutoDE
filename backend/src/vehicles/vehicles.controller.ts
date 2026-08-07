import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { AuthUser } from '../auth/jwt.strategy';
import { VehiclesService } from './vehicles.service';
import { AddCostDto, CreateVehicleDto, UpdateVehicleDto } from './dto';

@Controller('vehicles')
@UseGuards(JwtAuthGuard, RolesGuard)
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('status') status?: string, @Query('search') search?: string) {
    return this.vehicles.list(user.tenantId, status, search);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.vehicles.get(user.tenantId, id);
  }

  @Post()
  @Roles('ACCOUNTANT', 'SALES')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateVehicleDto) {
    return this.vehicles.create(user.tenantId, dto);
  }

  @Patch(':id')
  @Roles('ACCOUNTANT', 'SALES')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateVehicleDto) {
    return this.vehicles.update(user.tenantId, id, dto);
  }

  @Post(':id/costs')
  @Roles('ACCOUNTANT')
  addCost(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: AddCostDto) {
    return this.vehicles.addCost(user.tenantId, id, dto);
  }

  @Delete(':id')
  @Roles('ACCOUNTANT')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.vehicles.delete(user.tenantId, id);
  }
}
