import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { ApiController } from './api.controller';
import { HealthController } from './health.controller';

@Module({
  imports: [PortfolioModule, AlertsModule],
  controllers: [ApiController, HealthController],
})
export class ApiModule {}
