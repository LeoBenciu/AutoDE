import { Module } from '@nestjs/common';
import { SagaController } from './saga.controller';
import { SagaService } from './saga.service';

@Module({
  controllers: [SagaController],
  providers: [SagaService],
})
export class SagaModule {}
