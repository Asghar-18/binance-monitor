import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Analysis, Currency, Position } from '@bpm/shared';
import { KvService } from '../db/kv.service';
import { ClaudeService } from './claude.service';
import { positionInput } from './inputs';
import { TechnicalDetail, TechnicalService } from './technical.service';

const ON_DEMAND_COOLDOWN_MS = 5 * 60_000;

/** Indicators + Claude's read for a position; remembers the latest analysis per coin. */
@Injectable()
export class AnalysisService implements OnModuleInit {
  private latest = new Map<string, Analysis>();
  private lastOnDemand = new Map<string, number>();

  constructor(
    readonly technical: TechnicalService,
    readonly claude: ClaudeService,
    private readonly kv: KvService,
  ) {}

  async onModuleInit() {
    for (const { key, value } of await this.kv.byPrefix('analysis:')) {
      try {
        this.latest.set(key.slice('analysis:'.length), JSON.parse(value) as Analysis);
      } catch {
        /* ignore corrupt entry */
      }
    }
  }

  latestFor(asset: string): Analysis | null {
    return this.latest.get(asset) ?? null;
  }

  async explain(p: Position, currency: Currency, event: string | null): Promise<{ tech: TechnicalDetail | null; analysis: Analysis | null }> {
    const tech = await this.technical.compute(p.asset);
    const analysis = await this.claude.analyse(event ? 'alert' : 'on-demand', p.asset, positionInput(p, tech, currency, event));
    if (analysis) {
      this.latest.set(p.asset, analysis);
      await this.kv.set(`analysis:${p.asset}`, JSON.stringify(analysis));
    }
    return { tech, analysis };
  }

  /** Dashboard "Ask Claude" button, limited to once per 5 minutes per coin. */
  async onDemand(p: Position, currency: Currency): Promise<Analysis | null> {
    const last = this.lastOnDemand.get(p.asset) ?? 0;
    if (Date.now() - last < ON_DEMAND_COOLDOWN_MS) return this.latestFor(p.asset);
    this.lastOnDemand.set(p.asset, Date.now());
    return (await this.explain(p, currency, null)).analysis;
  }
}
