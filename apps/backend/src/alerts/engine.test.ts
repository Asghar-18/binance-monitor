import { describe, expect, it } from 'vitest';
import { evaluate, isQuietHour, parseDuration, passesCooldown, RuleState } from './engine';
import { parseThresholds } from '../config';

const cfg = { hysteresis: 1, watchMargin: 1 };
const rules = (): RuleState[] => [
  { id: 1, thresholdPct: -10, armed: true, watchSent: false },
  { id: 2, thresholdPct: -5, armed: true, watchSent: false },
  { id: 3, thresholdPct: 10, armed: true, watchSent: false },
];

describe('evaluate', () => {
  it('does nothing in the quiet middle', () => {
    const e = evaluate(rules(), 0, cfg);
    expect(e.fire).toBeNull();
    expect(e.watch).toBeNull();
    expect(e.disarm).toEqual([]);
  });

  it('fires once when -5 is crossed', () => {
    const e = evaluate(rules(), -5.2, cfg);
    expect(e.fire?.thresholdPct).toBe(-5);
    expect(e.disarm).toEqual([2]);
  });

  it('picks the furthest threshold when several are crossed at once', () => {
    const e = evaluate(rules(), -12, cfg);
    expect(e.fire?.thresholdPct).toBe(-10);
    expect(e.disarm.sort()).toEqual([1, 2]);
  });

  it('does not re-arm inside the hysteresis buffer', () => {
    const r = rules();
    r[1].armed = false;
    expect(evaluate(r, -4.5, cfg).rearm).toEqual([]);
    expect(evaluate(r, -3.9, cfg).rearm).toEqual([2]);
  });

  it('re-arms positive thresholds when P/L falls back below the buffer', () => {
    const r = rules();
    r[2].armed = false;
    expect(evaluate(r, 9.5, cfg).rearm).toEqual([]);
    expect(evaluate(r, 8.9, cfg).rearm).toEqual([3]);
  });

  it('a disarmed threshold does not fire again while still crossed', () => {
    const r = rules();
    r[1].armed = false;
    expect(evaluate(r, -6, cfg).fire).toBeNull();
  });

  it('sends one approaching alert, then resets after moving away', () => {
    const r = rules();
    expect(evaluate(r, -4.3, cfg).watch?.thresholdPct).toBe(-5);
    r[1].watchSent = true;
    expect(evaluate(r, -4.3, cfg).watch).toBeNull();
    expect(evaluate(r, -2.5, cfg).resetWatch).toEqual([2]);
  });

  it('no approaching alert when disabled', () => {
    expect(evaluate(rules(), -4.5, { hysteresis: 1, watchMargin: 0 }).watch).toBeNull();
  });
});

describe('passesCooldown', () => {
  const hour = 3_600_000;
  it('blocks a second alert within the window', () => {
    expect(passesCooldown(10, { at: 0, thresholdPct: -5 }, hour, 2 * hour)).toBe(false);
  });
  it('lets a deeper threshold through', () => {
    expect(passesCooldown(-10, { at: 0, thresholdPct: -5 }, hour, 2 * hour)).toBe(true);
  });
  it('allows alerts after the window', () => {
    expect(passesCooldown(-5, { at: 0, thresholdPct: -5 }, 3 * hour, 2 * hour)).toBe(true);
  });
});

describe('helpers', () => {
  it('quiet hours wrap past midnight in Karachi time', () => {
    // 20:30 UTC = 01:30 in Karachi (UTC+5)
    expect(isQuietHour(new Date('2026-09-28T20:30:00Z'), '23-7', 'Asia/Karachi')).toBe(true);
    // 07:30 UTC = 12:30 in Karachi
    expect(isQuietHour(new Date('2026-09-28T07:30:00Z'), '23-7', 'Asia/Karachi')).toBe(false);
  });

  it('parses durations', () => {
    expect(parseDuration('6h')).toBe(6 * 3_600_000);
    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('abc')).toBeNull();
  });

  it('parses thresholds, including the unicode minus', () => {
    expect(parseThresholds('+10, \u22125, -10%, 20')).toEqual([-10, -5, 10, 20]);
    expect(() => parseThresholds('0')).toThrow();
  });
});
