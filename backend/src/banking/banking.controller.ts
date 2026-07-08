import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { AuthUser } from '../auth/jwt.strategy';
import { PrismaService } from '../common/prisma.service';
import { PayablesService } from './payables.service';
import { ReconciliationService } from './reconciliation.service';

@Controller('banking')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BankingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payables: PayablesService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  // --- Accounts & transactions (AIS read side) ---

  @Get('accounts')
  accounts(@CurrentUser() user: AuthUser) {
    return this.prisma.bankAccount.findMany({ where: { tenantId: user.tenantId } });
  }

  @Get('accounts/:id/transactions')
  transactions(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.prisma.bankTransaction.findMany({
      where: { bankAccountId: id, bankAccount: { tenantId: user.tenantId } },
      orderBy: { bookingDate: 'desc' },
      take: 200,
    });
  }

  // --- Payables (bill pay) ---

  @Get('payables')
  listPayables(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return this.payables.list(user.tenantId, status);
  }

  @Post('payables/from-document/:documentId')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  fromDocument(@CurrentUser() user: AuthUser, @Param('documentId', ParseIntPipe) documentId: number) {
    return this.payables.createFromDocument(user.tenantId, documentId);
  }

  @Post('payables')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  createPayable(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.payables.createManual(user.tenantId, body);
  }

  @Post('payables/:id/approve')
  @Roles('OWNER', 'MANAGER')
  approve(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.payables.approve(user.tenantId, user.userId, id);
  }

  @Post('payables/:id/submit')
  @Roles('OWNER', 'MANAGER')
  submit(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.payables.submit(user.tenantId, user.userId, id);
  }

  // --- Reconciliation ---

  @Get('transactions/:id/suggestions')
  suggestions(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.reconciliation.suggest(user.tenantId, id);
  }

  @Post('transactions/:id/match/:payableId')
  @Roles('OWNER', 'MANAGER', 'ACCOUNTANT')
  match(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('payableId', ParseIntPipe) payableId: number,
  ) {
    return this.reconciliation.confirmMatch(user.tenantId, id, payableId);
  }
}
