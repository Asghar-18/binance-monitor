'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AlertItem, Currency, PortfolioSnapshot, Position } from '@bpm/shared';
import { money, percent, shortDate, threshold, time, tone } from '@/lib/format';
import { HoldingRow } from './HoldingRow';
import { AnalysisCard } from './Insight';

const POLL_MS = 15_000;
const SEGMENTS = ['--seg-1', '--seg-2', '--seg-3', '--seg-4', '--seg-5', '--seg-6'];

export function PortfolioView({ initial }: { initial: PortfolioSnapshot | null }) {
  const [snap, setSnap] = useState<PortfolioSnapshot | null>(initial);
  const [currency, setCurrency] = useState<Currency>('PKR');
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/portfolio', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      setSnap(body as PortfolioSnapshot);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    const id = setInterval(load, POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    if (!initial) load();
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [initial, load]);

  // Fall back to USD when there is no PKR rate yet.
  const cur: Currency = currency === 'PKR' && !snap?.fx.usdPkr ? 'USD' : currency;

  if (!snap) {
    return (
      <main className="page">
        <p className="wallet">Binance Spot wallet</p>
        <div className="empty">
          <strong>Connecting to your portfolio</strong>
          {loadError ? `The backend did not answer: ${loadError}. It retries every 30 seconds.` : 'Reading balances from Binance.'}
        </div>
      </main>
    );
  }

  const t = snap.totals;
  const totalValue = cur === 'PKR' ? t.valuePkr : t.valueUsd;
  const pnl = cur === 'PKR' ? t.pnlPkr : t.pnlUsd;
  const pnlPct = cur === 'PKR' ? t.pnlPkrPct : t.pnlUsdPct;
  const notices = buildNotices(snap, loadError);

  return (
    <main className="page">
      <header className="topbar">
        <p className="wallet">Binance Spot wallet</p>
        <div className="toggle" role="group" aria-label="Currency">
          {(['PKR', 'USD'] as const).map((c) => (
            <button key={c} type="button" aria-pressed={cur === c} onClick={() => setCurrency(c)} disabled={c === 'PKR' && !snap.fx.usdPkr}>
              {c}
            </button>
          ))}
        </div>
      </header>

      <section className="hero" aria-label="Portfolio total">
        <h1 className="total">{money(totalValue, cur)}</h1>
        {pnl !== null ? (
          <p className={`pnl ${tone(pnlPct)}`}>
            {money(pnl, cur, { signed: true })} ({percent(pnlPct)}) <span className="note">unrealized</span>
          </p>
        ) : (
          <p className="pnl flat">Set entry prices to see profit and loss</p>
        )}
        {(cur === 'PKR' || t.valuePkr !== null) && (
          <p className="alt">{cur === 'PKR' ? `${money(t.valueUsd, 'USD')} in USD` : `${money(t.valuePkr, 'PKR')} in PKR`}</p>
        )}
      </section>

      <Allocation positions={snap.positions} />

      {notices.length > 0 && (
        <div className="notice" role="status">
          {notices.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}

      <AlertChannelCard snap={snap} />

      <section className="holdings" aria-labelledby="holdings-title">
        <h2 id="holdings-title">Holdings</h2>
        {snap.positions.length === 0 ? (
          <div className="empty">
            <strong>No coins above {money(snap.dustThresholdUsd, 'USD')}</strong>
            Buy or transfer coins to your Spot wallet and they appear here within a minute.
          </div>
        ) : (
          <ul className="list">
            {snap.positions.map((p) => (
              <HoldingRow key={p.asset} position={p} currency={cur} aiConfigured={snap.status.ai.configured} onChanged={setSnap} />
            ))}
          </ul>
        )}
      </section>

      {snap.alerts.length > 0 && <RecentAlerts alerts={snap.alerts} />}

      <footer className="status">
        <p>
          {snap.status.liveFeed
            ? 'Live prices connected.'
            : `Live prices reconnecting; last price at ${time(snap.status.lastPriceAt)}.`}
        </p>
        <p>
          {snap.fx.usdPkr
            ? `USD/PKR ${snap.fx.usdPkr.toFixed(2)}, rate from ${shortDate(snap.fx.date)}.`
            : 'USD/PKR rate not loaded yet.'}
        </p>
        <p>
          {snap.status.tradeSyncRunning
            ? 'Importing trade history now.'
            : `Trade history imported at ${time(snap.status.lastTradeSync)}.`}
        </p>
        <form method="post" action="/api/auth/logout">
          <button type="submit" className="signout">Sign out</button>
        </form>
        {snap.hiddenDustCount > 0 && (
          <p>
            {snap.hiddenDustCount} small balance{snap.hiddenDustCount === 1 ? '' : 's'} under {money(snap.dustThresholdUsd, 'USD')} hidden.
          </p>
        )}
      </footer>
    </main>
  );
}

function Allocation({ positions }: { positions: Position[] }) {
  const priced = positions.filter((p) => p.sharePct !== null && p.sharePct > 0);
  if (priced.length === 0) return null;
  const top = priced.slice(0, SEGMENTS.length);
  const restShare = priced.slice(SEGMENTS.length).reduce((s, p) => s + (p.sharePct ?? 0), 0);
  const segments = [
    ...top.map((p, i) => ({ key: p.asset, label: p.asset, share: p.sharePct!, color: p.isStable ? '--seg-other' : SEGMENTS[i] })),
    ...(restShare > 0 ? [{ key: '_other', label: 'Other', share: restShare, color: '--seg-other' }] : []),
  ];

  return (
    <section aria-label="Allocation">
      <div className="strip" aria-hidden="true">
        {segments.map((s) => (
          <span key={s.key} style={{ flexGrow: s.share, background: `var(${s.color})` }} />
        ))}
      </div>
      <ul className="legend">
        {segments.map((s) => (
          <li key={s.key}>
            <i style={{ background: `var(${s.color})` }} />
            <b>{s.label}</b> {percent(s.share, { signed: false })}
          </li>
        ))}
      </ul>
    </section>
  );
}

function AlertChannelCard({ snap }: { snap: PortfolioSnapshot }) {
  const { ntfy, telegram: tg } = snap.status;
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function sendTest() {
    setState('sending');
    setError(null);
    try {
      const res = await fetch('/api/alerts/test', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      setState('sent');
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  }

  const channels = [ntfy.configured && 'ntfy', tg.linked && 'Telegram'].filter(Boolean) as string[];
  const showTelegramLink = tg.configured && !tg.linked;

  if (channels.length === 0 && !showTelegramLink) {
    return (
      <section className="tg">
        <h2>Phone alerts are off</h2>
        <p>Add NTFY_TOPIC to your .env file and restart the backend, then subscribe to the same topic in the ntfy app.</p>
      </section>
    );
  }

  return (
    <>
      {channels.length > 0 && (
        <div className="tg-linked">
          <span>Phone alerts are on via {channels.join(' and ')}.</span>
          <button type="button" className="link-btn inline" onClick={sendTest} disabled={state === 'sending'}>
            {state === 'sending' ? 'Sending' : state === 'sent' ? 'Test sent' : 'Send a test alert'}
          </button>
          {state === 'error' && error && <p className="form-msg">Test failed: {error}</p>}
          <DigestControl snap={snap} />
        </div>
      )}
      {showTelegramLink && (
        <section className="tg">
          <h2>Connect Telegram</h2>
          <p>Optional, alongside ntfy. Open your bot and press Start. Alerts can only go to the chat that sends this code.</p>
          {tg.linkUrl && (
            <a className="btn" href={tg.linkUrl} target="_blank" rel="noreferrer">
              Open Telegram
            </a>
          )}
          {tg.linkCode && (
            <p className="tg-code">
              Or send <code>/start {tg.linkCode}</code> to your bot.
            </p>
          )}
        </section>
      )}
    </>
  );
}

function DigestControl({ snap }: { snap: PortfolioSnapshot }) {
  const d = snap.status.digest;
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function sendNow() {
    setState('sending');
    setError(null);
    try {
      const res = await fetch('/api/digest/send', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      setState('sent');
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  }

  return (
    <div className="digest">
      <span>{d.time ? `Morning summary every day at ${d.time}.` : 'Morning summary is off.'}</span>
      <button type="button" className="link-btn inline" onClick={sendNow} disabled={state === 'sending'}>
        {state === 'sending' ? 'Preparing summary' : state === 'sent' ? 'Summary sent' : 'Send summary now'}
      </button>
      {state === 'error' && error && <p className="form-msg">Summary failed: {error}</p>}
    </div>
  );
}

const STATUS_TEXT: Record<AlertItem['status'], string> = {
  sent: '',
  failed: 'not delivered',
  suppressed: 'held back by cooldown',
  muted: 'muted',
  quiet: 'quiet hours',
  not_linked: 'no alert channel set up',
};

function RecentAlerts({ alerts }: { alerts: AlertItem[] }) {
  return (
    <section className="recent" aria-labelledby="recent-title">
      <h2 id="recent-title">Recent alerts</h2>
      <ul>
        {alerts.map((a) => {
          const head = (
            <>
              <span className={tone(a.pnlPct)}>
                <b>{a.asset}</b> {a.kind === 'watch' ? `near ${threshold(a.thresholdPct)}` : `crossed ${threshold(a.thresholdPct)}`}
              </span>
              <span className="when">
                {new Date(a.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                {STATUS_TEXT[a.status] && <em>{STATUS_TEXT[a.status]}</em>}
              </span>
            </>
          );
          return (
            <li key={a.id}>
              {a.analysis ? (
                <details>
                  <summary>{head}</summary>
                  <AnalysisCard analysis={a.analysis} compact />
                </details>
              ) : (
                <div className="recent-row">{head}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function buildNotices(snap: PortfolioSnapshot, loadError: string | null): string[] {
  const out: string[] = [];
  if (loadError) out.push(`Showing the last loaded data. The backend did not answer: ${loadError}.`);
  out.push(...snap.status.keyWarnings);
  if (snap.fx.stale && snap.fx.usdPkr) out.push(`The USD/PKR rate is from ${shortDate(snap.fx.date)} and may be out of date.`);
  const concentrated = snap.positions.find((p) => !p.isStable && (p.sharePct ?? 0) >= 40);
  if (concentrated) {
    out.push(`${concentrated.asset} is ${percent(concentrated.sharePct, { signed: false })} of your portfolio.`);
  }
  out.push(...snap.status.errors);
  return out;
}

