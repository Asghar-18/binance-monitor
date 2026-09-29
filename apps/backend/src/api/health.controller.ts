import { Controller, Get } from '@nestjs/common';
import { PortfolioService } from '../portfolio/portfolio.service';

/** Unauthenticated health check for Docker / Railway. Reveals no portfolio data. */
@Controller('health')
export class HealthController {
  constructor(private readonly portfolio: PortfolioService) {}

  @Get()
  health() {
    const snap = this.portfolio.getSnapshot();
    return { ok: !!snap, liveFeed: snap?.status.liveFeed ?? false };
  }
}
