import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { AuthUser } from '../auth/jwt.strategy';
import { AccountingService, UploadedCsv } from './accounting.service';

const CSV_UPLOAD = { limits: { fileSize: 10 * 1024 * 1024 } };

@Controller('accounting')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AccountingController {
  constructor(private readonly accounting: AccountingService) {}

  @Get('company')
  company(@CurrentUser() user: AuthUser) {
    return this.accounting.company(user.tenantId);
  }

  @Get('company/anaf/:cui')
  companyFromAnaf(
    @Param('cui') cui: string,
    @Headers('x-request-id') requestId?: string,
  ) {
    return this.accounting.companyFromAnaf(cui, requestId);
  }

  @Patch('company')
  @Roles('ACCOUNTANT')
  updateCompany(
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
  ) {
    return this.accounting.updateCompany(user.tenantId, body);
  }

  @Get('ledger')
  @Roles('ACCOUNTANT')
  ledger(
    @CurrentUser() user: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('accountCode') accountCode?: string,
    @Query('sourceType') sourceType?: string,
    @Query('documentId') documentId?: string,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ) {
    return this.accounting.ledger(user.tenantId, {
      from,
      to,
      accountCode,
      sourceType,
      documentId: documentId ? Number(documentId) : undefined,
      page: page ? Number(page) : undefined,
      size: size ? Number(size) : undefined,
    });
  }

  @Get('accounts')
  accounts(@Query('search') search?: string) {
    return this.accounting.accounts(search);
  }

  @Get('articles')
  articles(@CurrentUser() user: AuthUser, @Query('search') search?: string) {
    return this.accounting.articles(user.tenantId, search);
  }

  @Post('articles/import')
  @Roles('ACCOUNTANT')
  @UseInterceptors(FileInterceptor('file', CSV_UPLOAD))
  importArticles(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedCsv,
  ) {
    return this.accounting.importArticles(user.tenantId, file);
  }

  @Post('articles')
  @Roles('ACCOUNTANT')
  createArticle(
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
  ) {
    return this.accounting.createArticle(user.tenantId, body);
  }

  @Patch('articles/:id')
  @Roles('ACCOUNTANT')
  updateArticle(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.accounting.updateArticle(user.tenantId, id, body);
  }

  @Get('managements')
  managements(@CurrentUser() user: AuthUser) {
    return this.accounting.managements(user.tenantId);
  }

  @Post('managements/import')
  @Roles('ACCOUNTANT')
  @UseInterceptors(FileInterceptor('file', CSV_UPLOAD))
  importManagements(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedCsv,
  ) {
    return this.accounting.importManagements(user.tenantId, file);
  }

  @Post('managements')
  @Roles('ACCOUNTANT')
  createManagement(
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
  ) {
    return this.accounting.createManagement(user.tenantId, body);
  }

  @Patch('managements/:id')
  @Roles('ACCOUNTANT')
  updateManagement(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.accounting.updateManagement(user.tenantId, id, body);
  }
}
