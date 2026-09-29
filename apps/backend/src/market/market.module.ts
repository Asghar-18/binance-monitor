import { Module } from '@nestjs/common';
import { MarketService } from './market.service';
import { PriceStreamService } from './price-stream.service';

@Module({
  providers: [MarketService, PriceStreamService],
  exports: [MarketService, PriceStreamService],
})
export class MarketModule {}
