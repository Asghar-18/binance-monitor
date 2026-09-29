import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ApiModule } from './api/api.module';
import { BinanceModule } from './binance/binance.module';
import { ConfigModule } from './common/config.module';
import { DbModule } from './db/db.module';

@Module({
  imports: [ConfigModule, DbModule, BinanceModule, ScheduleModule.forRoot(), ApiModule],
})
export class AppModule {}
