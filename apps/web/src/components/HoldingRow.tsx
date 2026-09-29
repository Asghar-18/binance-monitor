'use client';

import { useId, useState } from 'react';
import type { Currency, EntrySource, PortfolioSnapshot, Position } from '@bpm/shared';
import { money, parseThresholdList, percent, quantity, threshold, tone } from '@/lib/format';

const SOURCE_TEXT: Record<EntrySource, string> = {
  history: 'from your trades',
  partial: '',
  manual: 'set by you',
  unknown: 'not known',
};

export function HoldingRow({
  position: p,
  currency,
  onChanged,
}: {
  position: Position;
  currency: Currency;
  onChanged: (s: PortfolioSnapshot) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const value = currency === 'PKR' ? p.valuePkr : p.valueUsd;
  const pnl = currency === 'PKR' ? p.pnl.pkr : p.pnl.usd;
  const pnlPct = currency === 'PKR' ? p.pnl.pkrPct : p.pnl.usdPct;
  const rate = p.valueUsd && p.valuePkr ? p.valuePkr / p.valueUsd : null;
  const price = p.priceUsd === null ? null : currency === 'PKR' ? (rate ? p.priceUsd * rate : null) : p.priceUsd;
  const entry = currency === 'PKR' ? p.entry.avgPkr : p.entry.avgUsd;

  const sourceText =
    p.entry.source === 'partial'
      ? `${Math.round(p.entry.coveragePct ?? 0)}% of coins from your trades`
      : SOURCE_TEXT[p.entry.source];

  return (
    <li className="row">
      <button type="button" className="row-head" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
        <span className="sym">
          {p.asset}
          {p.entry.source === 'manual' && <span className="badge">manual</span>}
          {p.entry.source === 'partial' && <span className="badge">partial</span>}
        </span>
        <span className="val">{money(value, currency)}</span>
        <span className="sub">
          {quantity(p.quantity)} {p.asset}
        </span>
        <span className={`sub right ${p.isStable ? 'flat' : tone(pnlPct)}`}>
          {p.isStable ? 'stablecoin' : pnlPct !== null ? percent(pnlPct) : 'no entry price'}
        </span>
      </button>

      {open && (
        <div className="detail" id={panelId}>
          <dl className="facts">
            <dt>Price</dt>
            <dd>
              {money(price, currency)}
              {p.change24hPct !== null && (
                <span className={`hint ${tone(p.change24hPct)}`}>{percent(p.change24hPct)} in 24 hours</span>
              )}
            </dd>
            {!p.isStable && (
              <>
                <dt>Average entry</dt>
                <dd>
                  {money(entry, currency)}
                  <span className="hint">{sourceText}</span>
                </dd>
                <dt>Profit or loss</dt>
                <dd className={tone(pnlPct)}>{pnl !== null ? `${money(pnl, currency, { signed: true })} (${percent(pnlPct)})` : '—'}</dd>
              </>
            )}
            <dt>Share of portfolio</dt>
            <dd>{percent(p.sharePct, { signed: false })}</dd>
            {p.alerts && (
              <>
                <dt>Alerts</dt>
                <dd>
                  {p.alerts.thresholds.length === 0 ? (
                    'none'
                  ) : (
                    <span className="chips">
                      {p.alerts.thresholds.map((t) => (
                        <span key={t.pct} className={`chip ${t.armed ? '' : 'fired'}`} title={t.armed ? 'Waiting' : 'Fired; re-arms when P/L moves back'}>
                          {threshold(t.pct)}
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="hint">
                    {p.alerts.mutedUntil
                      ? `Muted until ${new Date(p.alerts.mutedUntil).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
                      : `P/L in ${p.alerts.currency} from your average`}
                  </span>
                </dd>
              </>
            )}
          </dl>
          {!p.isStable && <EntryEditor position={p} currency={currency} onChanged={onChanged} />}
          {p.alerts && <ThresholdEditor position={p} onChanged={onChanged} />}
        </div>
      )}
    </li>
  );
}

function EntryEditor({
  position: p,
  currency,
  onChanged,
}: {
  position: Position;
  currency: Currency;
  onChanged: (s: PortfolioSnapshot) => void;
}) {
  const [editing, setEditing] = useState(p.entry.source === 'unknown');
  const [price, setPrice] = useState('');
  const [inputCurrency, setInputCurrency] = useState<Currency>(currency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  async function send(method: 'PUT' | 'DELETE') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/holdings/${p.asset}/entry`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'PUT' ? JSON.stringify({ price: Number(price.replace(/,/g, '')), currency: inputCurrency }) : undefined,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      onChanged(body as PortfolioSnapshot);
      setEditing(false);
      setPrice('');
    } catch (e) {
      setError(`Could not save: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <button type="button" className="link-btn" onClick={() => setEditing(true)}>
        {p.entry.source === 'manual' ? 'Change entry price' : 'Set entry price yourself'}
      </button>
    );
  }

  const valid = Number(price.replace(/,/g, '')) > 0;
  return (
    <form
      className="entry-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void send('PUT');
      }}
    >
      <label htmlFor={inputId}>Average price you paid per {p.asset}</label>
      <div className="entry-fields">
        <input
          id={inputId}
          inputMode="decimal"
          autoComplete="off"
          placeholder={`Price in ${inputCurrency}`}
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
        <select aria-label="Currency of the price" value={inputCurrency} onChange={(e) => setInputCurrency(e.target.value as Currency)}>
          <option value="PKR">PKR</option>
          <option value="USD">USD</option>
        </select>
      </div>
      <div className="actions">
        <button type="submit" className="btn" disabled={!valid || busy}>
          {busy ? 'Saving' : 'Save entry price'}
        </button>
        {p.entry.source === 'manual' && (
          <button type="button" className="btn quiet" disabled={busy} onClick={() => send('DELETE')}>
            Use trade history instead
          </button>
        )}
        {p.entry.source !== 'unknown' && (
          <button type="button" className="btn quiet" disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </button>
        )}
      </div>
      {error && <p className="form-msg">{error}</p>}
    </form>
  );
}

function ThresholdEditor({ position: p, onChanged }: { position: Position; onChanged: (s: PortfolioSnapshot) => void }) {
  const current = (p.alerts?.thresholds ?? []).map((t) => threshold(t.pct)).join(', ');
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  async function save() {
    setError(null);
    let thresholds: number[];
    try {
      thresholds = parseThresholdList(value);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/holdings/${p.asset}/thresholds`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ thresholds }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      onChanged(body as PortfolioSnapshot);
      setEditing(false);
    } catch (e) {
      setError(`Could not save: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="link-btn"
        onClick={() => {
          setValue(current);
          setEditing(true);
        }}
      >
        Change alerts
      </button>
    );
  }

  return (
    <form
      className="entry-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor={inputId}>Alert when P/L from your average reaches</label>
      <div className="entry-fields">
        <input id={inputId} inputMode="text" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="-5, -10, +10, +20" />
      </div>
      <p className="field-hint">Separate with commas. Leave empty to turn alerts off for {p.asset}.</p>
      <div className="actions">
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Saving' : 'Save alerts'}
        </button>
        <button type="button" className="btn quiet" disabled={busy} onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
      {error && <p className="form-msg">{error}</p>}
    </form>
  );
}
