import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentsProcessor } from './documents.processor';
import { ExtractionModule } from '../extraction/extraction.module';
import { AccountingModule } from '../accounting/accounting.module';

@Module({
  imports: [ExtractionModule, AccountingModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentsProcessor],
  exports: [DocumentsService],
})
export class DocumentsModule {}
