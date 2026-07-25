import { Module } from '@nestjs/common';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';
import { PostingService } from './posting.service';

@Module({
  controllers: [AccountingController],
  providers: [AccountingService, PostingService],
  exports: [AccountingService, PostingService],
})
export class AccountingModule {}
