import { Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { AlertService } from './alert.service';
import { DigestService } from './digest.service';
import { NotifierService } from './notifier.service';
import { NtfyClient } from './ntfy.client';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramClient } from './telegram.client';

@Module({
  imports: [PortfolioModule, AnalysisModule],
  providers: [TelegramClient, NtfyClient, NotifierService, AlertService, DigestService, TelegramBotService],
  exports: [AlertService, NotifierService, DigestService, AnalysisModule],
})
export class AlertsModule {}
