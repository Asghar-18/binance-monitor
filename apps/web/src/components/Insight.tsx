'use client';

import { useState } from 'react';
import type { Analysis, Currency, PortfolioSnapshot, Position, Timeframe } from '@bpm/shared';
import { money } from '@/lib/format';

const TFS: Timeframe[] = ['1h', '4h', '1d'];

export function TechnicalTable({ position: p, currency }: { position: Position; currency: Currency }) {
  const t = p.technical;
  if (!t) return null;
  const rate = currency === 'PKR' && p.valueUsd && p.valuePkr ? p.valuePkr / p.valueUsd : 1;
  const conv = (usd: number | null) => (usd === null ? null : usd * rate);

  return (
    <div className="tech">
      <h3>Technical picture</h3>
      <div className="tech-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">Indicator</span></th>
              {TFS.map((tf) => (
                <th key={tf} scope="col">{tf}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Trend</th>
              {TFS.map((tf) => {
                const tr = t.timeframes[tf]?.trend ?? null;
                return (
                  <td key={tf} className={tr === 'bullish' ? 'gain' : tr === 'bearish' ? 'loss' : ''}>
                    {tr ?? '—'}
                  </td>
                );
              })}
            </tr>
            <tr>
              <th scope="row" title="Relative Strength Index: below 30 is low, above 70 is high">RSI</th>
              {TFS.map((tf) => {
                const r = t.timeframes[tf]?.rsi;
                return <td key={tf}>{r === null || r === undefined ? '—' : r.toFixed(0)}</td>;
              })}
            </tr>
            <tr>
              <th scope="row" title="Last candle's volume compared with the average of the previous 20">Volume</th>
              {TFS.map((tf) => {
                const v = t.timeframes[tf]?.volumeRatio;
                return <td key={tf}>{v === null || v === undefined ? '—' : `${v.toFixed(1)}×`}</td>;
              })}
            </tr>
          </tbody>
        </table>
      </div>
      <dl className="levels">
        <dt>Support</dt>
        <dd>{money(conv(t.supportUsd), currency)}</dd>
        <dt>Resistance</dt>
        <dd>{money(conv(t.resistanceUsd), currency)}</dd>
      </dl>
    </div>
  );
}

export function AnalysisCard({ analysis, compact = false }: { analysis: Analysis; compact?: boolean }) {
  return (
    <div className={`ai ${compact ? 'compact' : ''}`}>
      {!compact && <p className="ai-head">{analysis.headline}</p>}
      <p>{analysis.summary}</p>
      {analysis.context && <p>{analysis.context}</p>}
      {analysis.watch.length > 0 && (
        <ul>
          {analysis.watch.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ClaudeRead({
  position: p,
  aiConfigured,
  onChanged,
}: {
  position: Position;
  aiConfigured: boolean;
  onChanged: (s: PortfolioSnapshot) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/holdings/${p.asset}/analysis`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      onChanged(body as PortfolioSnapshot);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const a = p.analysis;
  return (
    <div className="claude">
      <h3>
        Claude&rsquo;s read
        {a && (
          <span className="when">
            {new Date(a.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </h3>
      {a ? <AnalysisCard analysis={a} /> : <p className="field-hint">No analysis yet. One is written for every alert.</p>}
      {aiConfigured ? (
        <button type="button" className="link-btn" onClick={ask} disabled={busy}>
          {busy ? 'Claude is reading the charts…' : a ? 'Ask Claude again' : 'Ask Claude now'}
        </button>
      ) : (
        <p className="field-hint">Add ANTHROPIC_API_KEY to the backend to turn on Claude&rsquo;s explanations.</p>
      )}
      {error && <p className="form-msg">{error}</p>}
      <p className="disclaimer">Describes the numbers only. Not financial advice; decisions stay yours.</p>
    </div>
  );
}
