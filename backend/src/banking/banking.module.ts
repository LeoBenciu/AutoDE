import { Module } from '@nestjs/common';
import { BankingController } from './banking.controller';
import { PayablesService } from './payables.service';
import { ReconciliationService } from './reconciliation.service';
import { BankSyncService } from './bank-sync.service';

@Module({
  controllers: [BankingController],
  providers: [PayablesService, ReconciliationService, BankSyncService],
})
export class BankingModule {}
