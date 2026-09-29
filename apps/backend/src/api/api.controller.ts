import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AlertService } from '../alerts/alert.service';
import { DigestService } from '../alerts/digest.service';
import { NotifierService } from '../alerts/notifier.service';
import { AnalysisService } from '../analysis/analysis.service';
import { ApiTokenGuard } from '../common/auth.guard';
import { PortfolioService } from '../portfolio/portfolio.service';

const entrySchema = z.object({
  price: z.number().positive(),
  currency: z.enum(['PKR', 'USD']),
});

const thresholdsSchema = z.object({
  thresholds: z
    .array(z.number().refine((n) => n !== 0 && n >= -99 && n <= 1000, 'Thresholds must be between -99 and 1000, not 0'))
    .max(10),
});

const assetParam = (asset: string) => {
  const a = asset.toUpperCase();
  if (!/^[A-Z0-9]{1,20}$/.test(a)) throw new BadRequestException('Invalid asset');
  return a;
};

@Controller('api')
@UseGuards(ApiTokenGuard)
export class ApiController {
  constructor(
    private readonly portfolio: PortfolioService,
    private readonly alerts: AlertService,
    private readonly notifier: NotifierService,
    private readonly digest: DigestService,
    private readonly analysis: AnalysisService,
  ) {}

  private async snapshot() {
    const snap = await this.alerts.decorate(this.portfolio.getSnapshot());
    if (!snap) throw new ServiceUnavailableException('Portfolio is still loading');
    return snap;
  }

  @Get('portfolio')
  get() {
    return this.snapshot();
  }

  @Put('holdings/:asset/entry')
  async setEntry(@Param('asset') asset: string, @Body() body: unknown) {
    const parsed = entrySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Send { price: number > 0, currency: "PKR" | "USD" }');
    await this.portfolio.setOverride(assetParam(asset), parsed.data.price, parsed.data.currency);
    return this.snapshot();
  }

  @Delete('holdings/:asset/entry')
  async clearEntry(@Param('asset') asset: string) {
    await this.portfolio.clearOverride(assetParam(asset));
    return this.snapshot();
  }

  @Put('holdings/:asset/thresholds')
  async setThresholds(@Param('asset') asset: string, @Body() body: unknown) {
    const parsed = thresholdsSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Invalid thresholds');
    const unique = [...new Set(parsed.data.thresholds.map((n) => Math.round(n * 100) / 100))].sort((a, b) => a - b);
    await this.alerts.setThresholds(assetParam(asset), unique);
    return this.snapshot();
  }

  @Post('holdings/:asset/analysis')
  @HttpCode(200)
  async analyse(@Param('asset') asset: string) {
    if (!this.analysis.claude.configured) throw new BadRequestException('ANTHROPIC_API_KEY is not set on the backend');
    const a = assetParam(asset);
    const p = this.portfolio.getSnapshot()?.positions.find((x) => x.asset === a);
    if (!p || p.isStable) throw new BadRequestException(`No analysable holding for ${a}`);
    const currency = p.pnl.pkrPct !== null ? 'PKR' : 'USD';
    const result = await this.analysis.onDemand(p, currency);
    if (!result) throw new ServiceUnavailableException('Claude did not return a usable analysis. Try again in a few minutes.');
    return this.snapshot();
  }

  @Post('digest/send')
  @HttpCode(200)
  async sendDigest() {
    if (!this.notifier.anyChannel) throw new BadRequestException('No alert channel is set up');
    const ok = await this.digest.send();
    if (!ok) throw new ServiceUnavailableException('Summary was not delivered. Check the backend logs.');
    return { ok };
  }

  @Post('alerts/test')
  @HttpCode(200)
  async testAlert() {
    if (!this.notifier.anyChannel) throw new BadRequestException('No alert channel is set up. Add NTFY_TOPIC to .env.');
    const result = await this.notifier.send({
      severity: 'info',
      title: 'Test alert',
      lines: ['Your portfolio monitor can reach your phone.'],
    });
    if (!result.delivered) throw new ServiceUnavailableException('No channel accepted the message. Check the backend logs.');
    return result;
  }
}
