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
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { AuthUser } from '../auth/jwt.strategy';
import { AccountingService } from './accounting.service';

@Controller('accounting')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AccountingController {
  constructor(private readonly accounting: AccountingService) {}

  @Get('company')
  company(@CurrentUser() user: AuthUser) {
    return this.accounting.company(user.tenantId);
  }

  @Get('company/anaf/:cui')
  companyFromAnaf(@Param('cui') cui: string) {
    return this.accounting.companyFromAnaf(cui);
  }

  @Patch('company')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  updateCompany(
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
  ) {
    return this.accounting.updateCompany(user.tenantId, body);
  }

  @Get('ledger')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
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

  @Post('articles')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  createArticle(
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
  ) {
    return this.accounting.createArticle(user.tenantId, body);
  }

  @Patch('articles/:id')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
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

  @Post('managements')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  createManagement(
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
  ) {
    return this.accounting.createManagement(user.tenantId, body);
  }

  @Patch('managements/:id')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  updateManagement(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.accounting.updateManagement(user.tenantId, id, body);
  }
}
