import {
  Body,
  Controller,
  Delete,
  Get,
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
  constructor(private readonly documents: DocumentsService) {}

  @Post('upload')
  @Roles('OWNER', 'MANAGER', 'SALES', 'ACCOUNTANT')
  @UseInterceptors(FilesInterceptor('files', 20, { limits: { fileSize: 50 * 1024 * 1024 } }))
  async upload(
    @CurrentUser() user: AuthUser,
    @UploadedFiles() files: UploadedDoc[],
    @Body('vehicleId') vehicleId?: string,
    @Body('partyId') partyId?: string,
  ) {
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

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.documents.get(user.tenantId, id);
  }

  @Get(':id/download')
  download(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.documents.downloadUrl(user.tenantId, id);
  }

  @Post(':id/corrections')
  @Roles('OWNER', 'MANAGER', 'SALES', 'ACCOUNTANT')
  correct(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { field: string; newValue: string },
  ) {
    return this.documents.correctField(user.tenantId, user.userId, id, body.field, body.newValue);
  }

  @Post(':id/reviewed')
  @Roles('OWNER', 'MANAGER', 'SALES', 'ACCOUNTANT')
  markReviewed(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.documents.markReviewed(user.tenantId, id);
  }

  @Post(':id/assign')
  @Roles('OWNER', 'MANAGER', 'SALES', 'ACCOUNTANT')
  assign(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { vehicleId?: number | null; partyId?: number | null },
  ) {
    return this.documents.assign(user.tenantId, id, body.vehicleId, body.partyId);
  }

  @Post(':id/archive')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  archive(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.documents.setArchived(user.tenantId, id, user.userId, true);
  }

  @Post(':id/unarchive')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  unarchive(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.documents.setArchived(user.tenantId, id, user.userId, false);
  }

  @Delete(':id')
  @Roles('OWNER', 'MANAGER')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.documents.softDelete(user.tenantId, id, user.userId);
  }
}
