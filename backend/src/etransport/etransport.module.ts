import { Module } from '@nestjs/common';
import { EtransportController } from './etransport.controller';
import { EtransportService } from './etransport.service';
import { AnafClient } from './anaf-client';
import { ExtractionModule } from '../extraction/extraction.module';
import { DriveVehicleDataService } from './drive-vehicle-data.service';

@Module({
  imports: [ExtractionModule],
  controllers: [EtransportController],
  providers: [EtransportService, AnafClient, DriveVehicleDataService],
})
export class EtransportModule {}
