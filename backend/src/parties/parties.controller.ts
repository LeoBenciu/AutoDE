import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { AuthUser } from '../auth/jwt.strategy';
import { PartiesService } from './parties.service';
import { CreatePartyDto, UpdatePartyDto } from './dto';

@Controller('parties')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PartiesController {
  constructor(private readonly parties: PartiesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('search') search?: string) {
    return this.parties.list(user.tenantId, search);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.parties.get(user.tenantId, id);
  }

  @Post()
  @Roles('OWNER', 'MANAGER', 'SALES', 'ACCOUNTANT')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePartyDto) {
    return this.parties.create(user.tenantId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'MANAGER', 'SALES', 'ACCOUNTANT')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePartyDto) {
    return this.parties.update(user.tenantId, id, dto);
  }
}
