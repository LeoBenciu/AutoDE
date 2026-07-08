import { Module } from '@nestjs/common';
import { EtransportController } from './etransport.controller';
import { EtransportService } from './etransport.service';
import { AnafClient } from './anaf-client';

@Module({
  controllers: [EtransportController],
  providers: [EtransportService, AnafClient],
})
export class EtransportModule {}
