import { describe, expect, it } from 'vitest';
import { allowedNumbers, checkOutput, numbersIn } from './guardrails';

const input = { price: 'Rs 55.20', pnl_from_entry: '−5.5%', support: 'Rs 53.10', rsi_1h: '31', volume_1h: '1.5x' };
const allowed = allowedNumbers(input);
const reply = (o: object) => JSON.stringify({ headline: 'XLM is down 5.5% from entry', summary: 'Momentum is weak on short timeframes.', context: 'Daily trend neutral.', watch: [], ...o });

describe('guardrails', () => {
  it('normalizes numbers', () => {
    expect(numbersIn('Rs 1,264.50 and 05')).toEqual(['1264.5', '5']);
  });

  it('accepts a descriptive answer using input numbers', () => {
    const v = checkOutput(reply({ summary: 'XLM is at Rs 55.20 with RSI 31 on the 1h chart and volume 1.5x its 20-candle average.', watch: ['Support at Rs 53.10'] }), allowed);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('tolerates code fences around the JSON', () => {
    expect(checkOutput('```json\n' + reply({}) + '\n```', allowed).ok).toBe(true);
  });

  it('rejects advice', () => {
    expect(checkOutput(reply({ summary: 'You should sell before it gets worse.' }), allowed).ok).toBe(false);
    expect(checkOutput(reply({ summary: 'This could be a good time to buy the dip here.' }), allowed).ok).toBe(false);
    expect(checkOutput(reply({ context: 'Consider taking profit.' }), allowed).ok).toBe(false);
  });

  it('rejects predictions', () => {
    expect(checkOutput(reply({ summary: 'Price will bounce from support soon.' }), allowed).ok).toBe(false);
  });

  it('rejects invented numbers', () => {
    const v = checkOutput(reply({ watch: ['Support at Rs 50.00'] }), allowed);
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toContain('50');
  });

  it('allows standard periods like EMA 200 and 4h', () => {
    expect(checkOutput(reply({ context: 'Price is above the 200-day EMA and the 4h trend is bearish.' }), allowed).ok).toBe(true);
  });

  it('rejects broken JSON and wrong shapes', () => {
    expect(checkOutput('Sorry, I cannot help', allowed).ok).toBe(false);
    expect(checkOutput('{"headline": "x"}', allowed).ok).toBe(false);
  });

  it('rejects placeholders for missing data', () => {
    expect(checkOutput(reply({ watch: ['Support near null'] }), allowed).ok).toBe(false);
  });

  it('does not flag neutral market words', () => {
    expect(checkOutput(reply({ summary: 'Selling pressure increased on the 1h chart while buyers held support.' }), allowed).ok).toBe(true);
  });
});
