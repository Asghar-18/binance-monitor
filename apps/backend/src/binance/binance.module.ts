import { Global, Module } from '@nestjs/common';
import { BinanceClient } from './binance.client';

@Global()
@Module({
  providers: [BinanceClient],
  exports: [BinanceClient],
})
export class BinanceModule {}
