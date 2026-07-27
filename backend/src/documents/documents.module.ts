import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentsProcessor } from './documents.processor';
import { ExtractionModule } from '../extraction/extraction.module';
import { AccountingModule } from '../accounting/accounting.module';
import { DocumentDomainSyncService } from './document-domain-sync.service';

@Module({
  imports: [ExtractionModule, AccountingModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentsProcessor, DocumentDomainSyncService],
  exports: [DocumentsService, DocumentDomainSyncService],
})
export class DocumentsModule {}
