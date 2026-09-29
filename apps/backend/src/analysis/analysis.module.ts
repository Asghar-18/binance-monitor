import { Module } from '@nestjs/common';
import { MarketModule } from '../market/market.module';
import { AnalysisService } from './analysis.service';
import { ClaudeService } from './claude.service';
import { TechnicalService } from './technical.service';

@Module({
  imports: [MarketModule],
  providers: [TechnicalService, ClaudeService, AnalysisService],
  exports: [AnalysisService],
})
export class AnalysisModule {}
