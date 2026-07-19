import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { AuthUser } from '../auth/jwt.strategy';
import { SagaService } from './saga.service';

@Controller('saga')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SagaController {
  constructor(private readonly saga: SagaService) {}

  @Get('export.:format')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async export(
    @CurrentUser() user: AuthUser,
    @Param('format') format: string,
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const fmt = format === 'csv' ? 'csv' : 'xml';
    const result = await this.saga.export(user.tenantId, user.userId, fmt, from, to);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
    res.setHeader('X-Invoice-Count', String(result.count));
    res.send(result.content);
  }

  @Get('parteneri.xml')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async exportPartners(
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
    @Query('tip') tip?: string,
  ) {
    const kind = tip === 'furnizori' ? 'furnizori' : 'clienti';
    const result = await this.saga.exportPartners(user.tenantId, user.userId, kind);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
    res.setHeader('X-Invoice-Count', String(result.count));
    res.send(result.content);
  }
}
