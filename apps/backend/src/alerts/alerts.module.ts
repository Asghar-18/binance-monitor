import { Module } from '@nestjs/common';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { AlertService } from './alert.service';
import { NotifierService } from './notifier.service';
import { NtfyClient } from './ntfy.client';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramClient } from './telegram.client';

@Module({
  imports: [PortfolioModule],
  providers: [TelegramClient, NtfyClient, NotifierService, AlertService, TelegramBotService],
  exports: [AlertService, NotifierService],
})
export class AlertsModule {}
