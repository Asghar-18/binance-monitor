# Binance Portfolio Monitor (V1)

Watches your Binance **Spot wallet**, works out what you paid for each coin from your trade history, and shows value and profit/loss in **PKR** (with a USD toggle) on a phone-first dashboard.

It sends Telegram alerts when a coin's profit/loss crosses thresholds you choose. It is read-only: it never places orders.

## What is included

- **Backend** (`apps/backend`, NestJS): read-only Binance connection, a startup check that refuses keys with trading or withdrawal permission, balances every minute, Spot trade and Convert history import, weighted-average cost basis in USD and PKR, manual entry-price overrides, USD/PKR rates.
- **Live prices** over Binance WebSocket, with automatic reconnects.
- **Phone alerts** through the ntfy app (no VPN needed) and optionally Telegram, when P/L from your average entry crosses a threshold. A buffer stops a price wobbling around a level from spamming you, with a cooldown per coin, quiet hours, and mute. Manage thresholds on the dashboard (or with Telegram bot commands).
- **Technical picture** for each coin on 1h, 4h and daily candles: trend, RSI, volume, support and resistance.
- **Claude's explanation** inside every threshold alert and on demand: what is happening in plain English. It describes the numbers only and never says buy or sell (see "How Claude is kept honest").
- **Morning summary** each day at 09:00: portfolio value, 24h move, P/L and each coin's daily trend, with a short summary from Claude.
- **Dashboard** (`apps/web`, Next.js): total value, P/L, allocation strip, holdings with details, entry prices, alert thresholds, recent alerts with analysis. Sign-in with password and 2FA. Light and dark mode.
- **Shared types** (`packages/shared`).
- **Postgres** for trades, sync progress, exchange rates and your overrides.
- **Docker Compose** for running everything, with optional automatic HTTPS through Caddy.

## 1. Create a read-only Binance API key

1. Binance → Account → API Management → Create API → System generated.
2. Tick **only "Enable Reading"**. Leave trading, withdrawals and transfers off.
3. When you deploy to a server, edit the key and restrict it to your server's IP.
4. Copy the API key and secret. Never share them or paste them into a chat.

## 2. Configure

```bash
cp .env.example .env
```

Fill in `BINANCE_API_KEY`, `BINANCE_API_SECRET`, and make up `POSTGRES_PASSWORD`, `API_TOKEN`, `DASHBOARD_PASSWORD` and `SESSION_SECRET`. A quick way to generate each secret:

```bash
openssl rand -hex 24
```

For two-step sign-in, also set `DASHBOARD_TOTP_SECRET` (the command is in `.env.example`) and add the same key to Google Authenticator with **Enter a setup key**. Without it, the dashboard asks only for the password, which is fine on your laptop but not online.

## 3. Set up phone alerts (ntfy)

1. Install **ntfy** from the Play Store or App Store.
2. Pick a long random topic name, e.g. `asghar-alerts-7f3k9q2m`. Anyone who knows it can read your alerts, so treat it like a password.
3. In the app tap **+** and subscribe to that topic (server: ntfy.sh).
4. Put the same name in `.env` as `NTFY_TOPIC`.
5. Start (or restart) the app and tap **Send a test alert** on the dashboard.

Loss alerts arrive at maximum priority (long vibration), gain alerts at high priority, and "approaching" alerts at low priority (no sound).

**Telegram (optional).** If Telegram works for you, add a bot token from @BotFather as `TELEGRAM_BOT_TOKEN`. The dashboard then shows a **Connect Telegram** card; tap **Open Telegram** and press **Start**. Alerts go to both ntfy and Telegram, and the bot also accepts commands (below).

## 4. Run on your computer

Needs Docker Desktop.

```bash
docker compose up -d --build
docker compose logs -f backend
```

Open http://localhost:3000 and sign in with your `DASHBOARD_PASSWORD` (and the 6-digit code, if 2FA is set).

The first start imports your trade history, which can take a few minutes. The dashboard shows balances straight away and fills in entry prices when the import finishes.

## 5. Deploy (runs 24/7, open from your phone)

**Recommended: Railway + Vercel.** Follow [DEPLOY.md](DEPLOY.md).

**Alternative: one VPS** (Hetzner, DigitalOcean, etc.) with Docker and a domain pointed at it. Copy the project and `.env` to the server, set `DOMAIN=your.domain.com`, and run:

```bash
docker compose --profile https up -d --build
```

Caddy gets an HTTPS certificate automatically.

## How alerts work

- Every coin you hold gets the thresholds in `DEFAULT_THRESHOLDS` (default −5%, −10%, +10%, +20% from your average entry). Change them per coin on the dashboard or with `/set`.
- P/L is measured in PKR when the exchange rate is available, otherwise USD.
- A threshold fires **once**. It re-arms only after P/L moves back past a 1-point buffer (so −5% re-arms above −4%).
- If a crash crosses several thresholds at once, you get one alert for the furthest.
- At most one alert per coin every 2 hours, except a deeper threshold (−10% after −5%) always comes through.
- A silent "approaching" message comes 1 point before a threshold. These are skipped during quiet hours; threshold alerts are not.
- No alerts during the first 5 minutes after startup or while prices are stale.

## How Claude is kept honest

Claude only interprets numbers the app has already calculated; it never calculates prices, P/L or indicators itself. Every reply is checked before it reaches you:

- **Advice is rejected**: phrases like "you should", "consider selling", "take profit", "buy the dip".
- **Predictions are rejected**: "will bounce", "is going to fall", price targets, stop-losses.
- **Invented numbers are rejected**: every number must appear in the data Claude was given.
- If a reply breaks a rule, Claude gets one retry with the reason. If that fails too, or Claude is slow (over 20 s) or over budget, the alert goes out anyway with just the numbers.

Every call is stored in the `llm_calls` table with its cost. Claude Haiku costs roughly $0.002 per alert; `LLM_MONTHLY_BUDGET_USD` (default $5) caps the monthly spend.

Indicators follow fixed rules: trend is **bullish** when price is above the 50-period EMA, the 20 EMA is above the 50, and the MACD histogram is positive; **bearish** is the mirror image; anything else is **neutral**. RSI uses 14 periods; volume compares the last closed candle with the average of the previous 20; support and resistance are the nearest swing lows and highs on 4h and daily candles.

### Telegram bot commands (optional)

| Command | What it does |
| --- | --- |
| `/portfolio` | Value and P/L of each coin |
| `/alerts` | Your thresholds and which have fired |
| `/set XLM -5 -10 +10 +20` | Change a coin's thresholds (`/set XLM off` removes them) |
| `/mute XLM 6h` | Pause a coin's alerts (`m`, `h` or `d`, up to 30 days) |
| `/unmute XLM` | Resume alerts |
| `/status` | Live price connection and last update |

## Useful commands

```bash
docker compose ps                     # what is running
docker compose logs -f backend        # backend logs
docker compose restart backend        # restart after editing .env
docker compose up -d --build          # rebuild after code changes
docker compose down                   # stop (data is kept)
```

## Developing without Docker for the apps

Needs Node 20+ and pnpm 9 (`corepack enable`).

```bash
pnpm install
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db
# in .env, uncomment DATABASE_URL and set your Postgres password
set -a && . ./.env && set +a
pnpm dev:backend         # http://localhost:4000
pnpm dev:web             # http://localhost:3000 (also needs API_TOKEN and DASHBOARD_PASSWORD in the env)
pnpm test                # cost-basis unit tests
```

After changing `apps/backend/src/db/schema.ts`, run `pnpm --filter @bpm/backend db:generate` to create a migration. Migrations run automatically on startup.

## How the numbers work

- **Prices** are in USDT, treated as USD. Coins without a USDT pair are priced through FDUSD, USDC or BTC.
- **Average entry** uses the weighted-average method. Buys raise the average; sells reduce quantity but keep the average.
- **Fees**: a fee taken in the coin you bought reduces its quantity; a fee paid in BNB or the quote coin is added to the cost.
- **PKR** values use today's USD/PKR rate. PKR cost uses the rate on each trade's date, so PKR P/L includes rupee movement.
- **Badges**: *partial* means only some of your coins came from trades the app can see (for example deposits from another exchange). *manual* means you set the price yourself, which always wins.

## Known limits

- Spot wallet only. Simple Earn (`LD…` assets), Funding and Futures are ignored.
- Trade history is imported for each coin you hold against the quote coins in `QUOTE_ASSETS`. Trades on delisted pairs cannot be fetched; set those entry prices manually.
- Convert history goes back `CONVERT_LOOKBACK_DAYS` (default 365).
- Historical USD/PKR rates start on 2 March 2024. Older trades use that day's rate for PKR cost.
- Only one copy of the app can read Telegram commands at a time. If you run it on your laptop and a server with the same bot token, stop one of them.

## Next steps

- Your own rules, e.g. "notify me when down 10% and RSI below 30".
- Alert evaluation: what the price did 1 day and 7 days after each alert.
