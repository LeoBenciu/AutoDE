import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { AuthUser } from '../auth/jwt.strategy';
import { CreateDeclarationInput, EtransportService } from './etransport.service';

@Controller('etransport')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EtransportController {
  constructor(private readonly etransport: EtransportService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('vehicleId') vehicleId?: string) {
    return this.etransport.list(user.tenantId, vehicleId ? Number(vehicleId) : undefined);
  }

  @Get('prefill/:vehicleId')
  prefill(@CurrentUser() user: AuthUser, @Param('vehicleId', ParseIntPipe) vehicleId: number) {
    return this.etransport.prefill(user.tenantId, vehicleId);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.etransport.get(user.tenantId, id);
  }

  @Post()
  @Roles('ACCOUNTANT')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDeclarationInput) {
    return this.etransport.create(user.tenantId, dto);
  }

  @Patch(':id')
  @Roles('ACCOUNTANT')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: CreateDeclarationInput) {
    return this.etransport.update(user.tenantId, user.userId, id, dto);
  }

  @Post(':id/submit')
  @Roles('ACCOUNTANT')
  submit(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.etransport.submit(user.tenantId, user.userId, id);
  }

  @Get(':id/uit-sheet')
  async uitSheet(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const pdf = await this.etransport.uitSheet(user.tenantId, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="uit-${id}.pdf"`);
    res.send(pdf);
  }
}
