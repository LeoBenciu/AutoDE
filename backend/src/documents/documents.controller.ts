import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { AuthUser } from '../auth/jwt.strategy';
import { DocumentsService, UploadedDoc } from './documents.service';

@Controller('documents')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DocumentsController {
  private readonly logger = new Logger(DocumentsController.name);

  constructor(private readonly documents: DocumentsService) {}

  @Post('upload')
  @Roles('ACCOUNTANT', 'SALES')
  @UseInterceptors(FilesInterceptor('files', 20, { limits: { fileSize: 50 * 1024 * 1024 } }))
  async upload(
    @CurrentUser() user: AuthUser,
    @UploadedFiles() files: UploadedDoc[],
    @Body('vehicleId') vehicleId?: string,
    @Body('partyId') partyId?: string,
  ) {
    this.logger.log(
      `upload hit: tenant=${user.tenantId} files=${files?.length ?? 0} ` +
        `[${(files ?? []).map((f) => `${f.originalname}(${f.size}b)`).join(', ')}] ` +
        `vehicleId=${vehicleId ?? '-'} partyId=${partyId ?? '-'}`,
    );
    if (!files?.length) {
      this.logger.warn('upload hit but no files were parsed from the request');
    }
    const results: Array<Awaited<ReturnType<DocumentsService['upload']>>> = [];
    for (const file of files ?? []) {
      results.push(
        await this.documents.upload(
          user.tenantId,
          file,
          vehicleId ? Number(vehicleId) : undefined,
          partyId ? Number(partyId) : undefined,
        ),
      );
    }
    return results;
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('vehicleId') vehicleId?: string,
    @Query('partyId') partyId?: string,
    @Query('type') type?: string,
    @Query('needsReview') needsReview?: string,
    @Query('search') search?: string,
    @Query('archived') archived?: string,
  ) {
    return this.documents.list(user.tenantId, {
      vehicleId: vehicleId ? Number(vehicleId) : undefined,
      partyId: partyId ? Number(partyId) : undefined,
      type,
      needsReview: needsReview === undefined ? undefined : needsReview === 'true',
      search,
      archived: archived === 'true',
    });
  }

  @Post('pending/:id/retry')
  @Roles('ACCOUNTANT', 'SALES')
  retryPending(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.documents.retryPendingUpload(user.tenantId, id);
  }

  @Post('pending/:id/cancel')
  @Roles('ACCOUNTANT', 'SALES')
  cancelPending(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.documents.cancelPendingUpload(user.tenantId, id);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.documents.get(user.tenantId, id);
  }

  @Get(':id/download')
  download(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.documents.downloadUrl(user.tenantId, id);
  }

  @Post(':id/corrections')
  @Roles('ACCOUNTANT', 'SALES')
  correct(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { field: string; newValue: unknown },
  ) {
    return this.documents.correctField(user.tenantId, user.userId, id, body.field, body.newValue);
  }

  @Post(':id/reprocess')
  @Roles('ACCOUNTANT', 'SALES')
  reprocess(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { documentType: string },
  ) {
    return this.documents.reprocess(
      user.tenantId,
      user.userId,
      id,
      body.documentType,
    );
  }

  @Post(':id/reviewed')
  @Roles('ACCOUNTANT')
  markReviewed(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.documents.markReviewed(user.tenantId, user.userId, id);
  }

  @Get(':id/posting-preview')
  @Roles('ACCOUNTANT')
  postingPreview(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.documents.previewPosting(user.tenantId, id);
  }

  @Post(':id/approve')
  @Roles('ACCOUNTANT')
  approve(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.documents.approve(user.tenantId, user.userId, id);
  }

  @Post(':id/reopen')
  @Roles('ACCOUNTANT')
  reopen(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.documents.reopen(user.tenantId, user.userId, id);
  }

  @Post(':id/assign')
  @Roles('ACCOUNTANT', 'SALES')
  assign(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { vehicleId?: number | null; partyId?: number | null },
  ) {
    return this.documents.assign(user.tenantId, id, body.vehicleId, body.partyId);
  }

  @Post(':id/archive')
  @Roles('ACCOUNTANT')
  archive(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.documents.setArchived(user.tenantId, id, user.userId, true);
  }

  @Post(':id/unarchive')
  @Roles('ACCOUNTANT')
  unarchive(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.documents.setArchived(user.tenantId, id, user.userId, false);
  }

  @Delete(':id')
  @Roles('ACCOUNTANT')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.documents.softDelete(user.tenantId, id, user.userId);
  }
}
