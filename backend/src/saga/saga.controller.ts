import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { AuthUser } from '../auth/jwt.strategy';
import { SagaExportRequest, SagaService } from './saga.service';

@Controller('saga')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SagaController {
  constructor(private readonly saga: SagaService) {}

  @Post('preview')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  preview(
    @CurrentUser() user: AuthUser,
    @Body() request: SagaExportRequest,
  ) {
    return this.saga.preview(user.tenantId, request);
  }

  @Get('preferences')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  preferences(@CurrentUser() user: AuthUser) {
    return this.saga.getPreferences(user.tenantId);
  }

  @Post('preferences')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  savePreferences(
    @CurrentUser() user: AuthUser,
    @Body() request: SagaExportRequest,
  ) {
    return this.saga.savePreferences(user.tenantId, request);
  }

  @Post('export')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  async exportZip(
    @CurrentUser() user: AuthUser,
    @Body() request: SagaExportRequest,
    @Res() res: Response,
  ) {
    const result = await this.saga.exportZip(
      user.tenantId,
      user.userId,
      request,
    );
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.fileName}"`,
    );
    res.setHeader('X-SAGA-File-Count', String(result.fileCount));
    res.send(result.content);
  }

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
