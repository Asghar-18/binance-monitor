/**
 * Pure alert logic: no I/O, fully unit-tested.
 *
 * A threshold is a P/L % from average entry (e.g. -5 or +10).
 * - It fires once when P/L crosses it, then disarms.
 * - It re-arms only after P/L moves back past a buffer (hysteresis),
 *   so a price wobbling around -5% does not send a stream of alerts.
 * - Several thresholds crossed at once produce one alert for the furthest.
 */

export interface RuleState {
  id: number;
  thresholdPct: number;
  armed: boolean;
  watchSent: boolean;
}

export interface EngineConfig {
  /** Points P/L must move back before a fired threshold re-arms */
  hysteresis: number;
  /** "Approaching" alert when within this many points; 0 disables */
  watchMargin: number;
}

export interface Evaluation {
  /** Threshold to alert on, if any */
  fire: RuleState | null;
  /** Rules to disarm (every armed rule that is now crossed) */
  disarm: number[];
  /** Rules to re-arm (disarmed rules P/L has moved back past) */
  rearm: number[];
  /** Armed rule P/L is approaching, if an "approaching" alert should go out */
  watch: RuleState | null;
  /** Rules whose "approaching" flag should reset because P/L moved away */
  resetWatch: number[];
}

export const isCrossed = (threshold: number, pnl: number) => (threshold < 0 ? pnl <= threshold : pnl >= threshold);

export function evaluate(rules: RuleState[], pnl: number, cfg: EngineConfig): Evaluation {
  const crossedArmed = rules.filter((r) => r.armed && isCrossed(r.thresholdPct, pnl));
  const fire = [...crossedArmed].sort((a, b) => Math.abs(b.thresholdPct) - Math.abs(a.thresholdPct))[0] ?? null;

  const rearm = rules
    .filter((r) => !r.armed)
    .filter((r) => (r.thresholdPct < 0 ? pnl > r.thresholdPct + cfg.hysteresis : pnl < r.thresholdPct - cfg.hysteresis))
    .map((r) => r.id);

  let watch: RuleState | null = null;
  const resetWatch: number[] = [];
  if (cfg.watchMargin > 0) {
    for (const r of rules) {
      if (!r.armed || isCrossed(r.thresholdPct, pnl)) continue;
      const distance = Math.abs(pnl - r.thresholdPct);
      if (r.watchSent && distance > cfg.watchMargin + cfg.hysteresis) resetWatch.push(r.id);
      if (!r.watchSent && distance <= cfg.watchMargin && !fire) {
        if (!watch || distance < Math.abs(pnl - watch.thresholdPct)) watch = r;
      }
    }
  }

  return { fire, disarm: crossedArmed.map((r) => r.id), rearm, watch, resetWatch };
}

export interface LastAlert {
  at: number;
  thresholdPct: number;
}

/**
 * Cooldown: at most one alert per coin per cooldown window,
 * except that a deeper threshold in the same direction (-10 after -5) always goes out.
 */
export function passesCooldown(thresholdPct: number, last: LastAlert | undefined, now: number, cooldownMs: number): boolean {
  if (!last || now - last.at >= cooldownMs) return true;
  const sameDirection = Math.sign(thresholdPct) === Math.sign(last.thresholdPct);
  return sameDirection && Math.abs(thresholdPct) > Math.abs(last.thresholdPct);
}

/** "23-7" -> true between 23:00 and 06:59 in the given time zone. */
export function isQuietHour(now: Date, quietHours: string, timeZone: string): boolean {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(quietHours);
  if (!m) return false;
  const start = Number(m[1]) % 24;
  const end = Number(m[2]) % 24;
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(now));
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** "6h", "30m", "2d" -> milliseconds; null if invalid */
export function parseDuration(input: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([mhd])$/i.exec(input.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as 'm' | 'h' | 'd'];
  const ms = n * unit;
  return ms > 0 && ms <= 30 * 86_400_000 ? ms : null;
}
