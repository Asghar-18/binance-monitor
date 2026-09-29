import { Module } from '@nestjs/common';
import { FxModule } from '../fx/fx.module';
import { MarketModule } from '../market/market.module';
import { TradeSyncService } from '../sync/trade-sync.service';
import { PortfolioService } from './portfolio.service';

@Module({
  imports: [FxModule, MarketModule],
  providers: [PortfolioService, TradeSyncService],
  exports: [PortfolioService],
})
export class PortfolioModule {}
