import { Module } from '@nestjs/common';
import { ExchangeController } from './exchange.controller';
import { ExchangeService } from './exchange.service';
import { PricingModule } from '../pricing/pricing.module';
import { CashModule } from '../cash/cash.module';
import { FeesModule } from '../fees/fees.module';

@Module({
  imports: [PricingModule, CashModule, FeesModule],
  controllers: [ExchangeController],
  providers: [ExchangeService],
  exports: [ExchangeService],
})
export class ExchangeModule {}
