import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { PartiesModule } from './parties/parties.module';
import { DocumentsModule } from './documents/documents.module';
import { ContractsModule } from './contracts/contracts.module';
import { EtransportModule } from './etransport/etransport.module';
import { BankingModule } from './banking/banking.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    CommonModule,
    AuthModule,
    VehiclesModule,
    PartiesModule,
    DocumentsModule,
    ContractsModule,
    EtransportModule,
    BankingModule,
  ],
})
export class AppModule {}
