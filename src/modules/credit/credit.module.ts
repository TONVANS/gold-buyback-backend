import { Module } from '@nestjs/common';
import { CreditController } from './credit.controller';
import { CreditService } from './credit.service';
import { PricingModule } from '../pricing/pricing.module';
import { CashModule } from '../cash/cash.module';

@Module({
  imports: [PricingModule, CashModule],
  controllers: [CreditController],
  providers: [CreditService],
  exports: [CreditService],
})
export class CreditModule {}
