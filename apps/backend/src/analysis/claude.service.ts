import { Inject, Injectable, Logger } from '@nestjs/common';
import { gte } from 'drizzle-orm';
import type { Analysis } from '@bpm/shared';
import { AppConfig, CONFIG } from '../config';
import { DB, Db } from '../db/tokens';
import { llmCalls } from '../db/schema';
import { allowedNumbers, AnalysisOutput, checkOutput } from './guardrails';

/**
 * Approximate prices in USD per million tokens (Claude Haiku 4.5: $1 in / $5 out).
 * Used only for the monthly budget cap; check https://platform.claude.com/docs/en/about-claude/pricing
 * if you switch ANTHROPIC_MODEL.
 */
const PRICE_IN_PER_MTOK = 1;
const PRICE_OUT_PER_MTOK = 5;
const TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT = `You explain a crypto holder's situation in plain English, using only the data in the JSON you receive.

Rules:
1. Describe, never advise. Do not tell the user to buy, sell, hold, add, trim, exit or take profit, and do not say what they should do.
2. No predictions. Do not say where the price will go, and give no price targets or stop-losses.
3. Use only numbers that appear in the input, written exactly as given (same currency symbol, same decimals). Do not calculate new numbers.
4. Short sentences. Explain indicators in passing, e.g. "RSI 29, which is low" or "volume 1.8x its recent average".
5. Mention when timeframes disagree (e.g. short-term bearish, daily neutral).

Reply with only a JSON object, no other text:
{"headline": "<under 90 characters>", "summary": "<2-3 sentences on what is happening now>", "context": "<1-2 sentences on the longer timeframe>", "watch": ["<up to 2 short items naming levels or conditions from the input>"]}`;

interface MessagesResponse {
  content: { type: string; text?: string }[];
  usage?: { input_tokens: number; output_tokens: number };
  error?: { message: string };
}

/**
 * Calls Claude through the Messages API, validates the reply with the guardrails,
 * retries once with feedback, and falls back to null (callers then send data-only alerts).
 */
@Injectable()
export class ClaudeService {
  private readonly log = new Logger('Claude');

  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(DB) private readonly db: Db,
  ) {
    if (cfg.ANTHROPIC_API_KEY) this.log.log(`Claude analysis on (${cfg.ANTHROPIC_MODEL}, budget $${cfg.LLM_MONTHLY_BUDGET_USD}/month)`);
    else this.log.log('ANTHROPIC_API_KEY not set; alerts are sent without analysis');
  }

  get configured(): boolean {
    return !!this.cfg.ANTHROPIC_API_KEY;
  }

  async spentThisMonth(): Promise<number> {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const rows = await this.db.select({ cost: llmCalls.costUsd }).from(llmCalls).where(gte(llmCalls.createdAt, start));
    return rows.reduce((s, r) => s + r.cost, 0);
  }

  async budgetLeft(): Promise<number | null> {
    if (!this.configured) return null;
    return Math.max(0, this.cfg.LLM_MONTHLY_BUDGET_USD - (await this.spentThisMonth()));
  }

  /** Returns a validated analysis, or null if Claude is off, over budget, slow, or broke the rules twice. */
  async analyse(purpose: string, asset: string | null, input: object): Promise<Analysis | null> {
    if (!this.configured) return null;
    if ((await this.budgetLeft())! <= 0) {
      this.log.warn('Monthly Claude budget used up; sending alerts without analysis');
      return null;
    }

    const allowed = allowedNumbers(input);
    const deadline = Date.now() + TIMEOUT_MS;
    let feedback: string | null = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 3000) break;
      const userText = JSON.stringify(input, null, 1) + (feedback ? `\n\nYour previous reply was rejected because it ${feedback}. Reply again following every rule.` : '');
      const started = Date.now();
      let raw = '';
      let usage = { input_tokens: 0, output_tokens: 0 };
      let problems: string[] = [];
      let output: AnalysisOutput | undefined;

      try {
        const res = await fetch(`${this.cfg.ANTHROPIC_BASE_URL}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.cfg.ANTHROPIC_API_KEY!,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: this.cfg.ANTHROPIC_MODEL,
            max_tokens: 600,
            temperature: 0.2,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userText }],
          }),
          signal: AbortSignal.timeout(remaining),
        });
        const body = (await res.json()) as MessagesResponse;
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.error?.message ?? 'unknown error'}`);
        raw = body.content.map((c) => c.text ?? '').join('');
        usage = body.usage ?? usage;
        const verdict = checkOutput(raw, allowed);
        problems = verdict.problems;
        output = verdict.ok ? verdict.output : undefined;
      } catch (e) {
        problems = [`request failed: ${(e as Error).message}`];
      }

      const cost = (usage.input_tokens * PRICE_IN_PER_MTOK + usage.output_tokens * PRICE_OUT_PER_MTOK) / 1_000_000;
      await this.db.insert(llmCalls).values({
        purpose,
        asset,
        model: this.cfg.ANTHROPIC_MODEL,
        input,
        output: raw || null,
        ok: !!output,
        problems: problems.join('; ') || null,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        costUsd: cost,
        latencyMs: Date.now() - started,
      });

      if (output) {
        return { ...output, createdAt: new Date().toISOString(), model: this.cfg.ANTHROPIC_MODEL };
      }
      this.log.warn(`${purpose} analysis rejected (attempt ${attempt}): ${problems.join('; ')}`);
      if (problems[0]?.startsWith('request failed')) break; // don't retry network/auth errors
      feedback = problems.join('; ');
    }
    return null;
  }
}
