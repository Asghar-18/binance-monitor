/**
 * Checks on Claude's output (pure, unit-tested).
 * - Must be valid JSON in the expected shape.
 * - Must not give buy/sell/hold advice or predict prices.
 * - Every number must come from the input (Claude may not invent or calculate numbers).
 */
import { z } from 'zod';

export const analysisSchema = z.object({
  headline: z.string().min(3).max(120),
  summary: z.string().min(10).max(700),
  context: z.string().max(500).default(''),
  watch: z.array(z.string().min(2).max(200)).max(3).default([]),
});
export type AnalysisOutput = z.infer<typeof analysisSchema>;

/** Periods, timeframes and RSI bands Claude may mention without them being in the input. */
const CONSTANTS = ['1', '2', '3', '4', '9', '12', '14', '20', '24', '26', '30', '50', '70', '100', '200'];

const BANNED: [RegExp, string][] = [
  [/\byou (should|must|need to|might want to|may want to)\b/i, 'tells the user what to do'],
  [/\b(i|we) (recommend|suggest|advise)\b/i, 'gives a recommendation'],
  [/\b(consider|time to|good time to|opportunity to) (buy|sell|add|exit|enter|hold|tak|trim|reduc|accumulat|average)/i, 'suggests a trade'],
  [/\b(buy|sell|hold) (now|more|it|this|the dip|signal)\b/i, 'suggests a trade'],
  [/\b(strong|clear) (buy|sell)\b/i, 'gives a trade signal'],
  [/\btak(e|ing) (some )?profits?\b/i, 'suggests taking profit'],
  [/\b(stop[- ]loss|price target|target price)\b/i, 'sets a target or stop'],
  [/\b(will|is going to|is likely to|should) (rise|fall|drop|rally|recover|crash|bounce|reach|climb|decline|rebound|go up|go down)\b/i, 'predicts price'],
  [/\bguarantee/i, 'makes a guarantee'],
  [/\b(null|undefined|NaN)\b/, 'mentions missing data'],
];

/** Pulls the first JSON object out of a model reply (tolerates code fences). */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in reply');
  return JSON.parse(text.slice(start, end + 1));
}

/** Numbers as they appear in text, normalized: "1,264.50" -> "1264.5", "05" -> "5". */
export function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => String(Number(n.replace(/,/g, ''))));
}

export function allowedNumbers(input: unknown): Set<string> {
  return new Set(numbersIn(JSON.stringify(input)));
}

/**
 * Numbers in the text that are not in the input. Indicator periods and timeframes (EMA 50, 4h, RSI 30)
 * are fine, but only when not written as money or a percentage, so "Rs 50.00" is still caught.
 */
export function unknownNumbers(text: string, allowed: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = String(Number(m[0].replace(/,/g, '')));
    if (allowed.has(n)) continue;
    const before = text.slice(Math.max(0, m.index! - 3), m.index!);
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 1);
    const isMoneyOrPct = /(\$|Rs\s?|₨\s?)$/.test(before) || after === '%';
    if (CONSTANTS.includes(n) && !isMoneyOrPct && !m[0].includes('.')) continue;
    out.add(n);
  }
  return [...out];
}

export interface Verdict {
  ok: boolean;
  output?: AnalysisOutput;
  problems: string[];
}

export function checkOutput(raw: string, allowed: Set<string>): Verdict {
  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch (e) {
    return { ok: false, problems: [`not valid JSON (${(e as Error).message})`] };
  }
  const shape = analysisSchema.safeParse(parsed);
  if (!shape.success) return { ok: false, problems: [`wrong shape: ${shape.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`] };

  const out = shape.data;
  const text = [out.headline, out.summary, out.context, ...out.watch].join('\n');
  const problems: string[] = [];
  for (const [re, why] of BANNED) {
    const m = re.exec(text);
    if (m) problems.push(`${why}: "${m[0]}"`);
  }
  const unknown = unknownNumbers(text, allowed);
  if (unknown.length) problems.push(`uses numbers not in the input: ${unknown.join(', ')}`);
  return { ok: problems.length === 0, output: out, problems };
}
