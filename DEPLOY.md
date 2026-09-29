# Deploy: Railway (backend + database) and Vercel (dashboard)

Once this is done, the monitor runs 24/7 without your laptop. Alerts reach your phone through ntfy, and the dashboard works anywhere at a Vercel web address, protected by your password and a 6-digit code.

Budget about 30 minutes. Railway costs about $5 a month (Hobby plan); Vercel's free plan is enough for the dashboard.

## 1. Prepare the sign-in secrets (on your laptop)

Run each command and keep the output somewhere private, such as a password manager.

```bash
# Signs your login cookie
openssl rand -hex 32

# 2FA key for your authenticator app
python3 -c "import base64,os;print(base64.b32encode(os.urandom(20)).decode())"
```

Add the 2FA key to **Google Authenticator** (or Microsoft Authenticator, Authy, etc.):

1. Tap **+**, then **Enter a setup key**.
2. Name it "Portfolio" and paste the key. Choose **Time based**.
3. The app now shows a 6-digit code that changes every 30 seconds.

You will also need these values from your current `.env`: `BINANCE_API_KEY`, `BINANCE_API_SECRET`, `API_TOKEN`, `DASHBOARD_PASSWORD`, `NTFY_TOPIC`.

## 2. Push the code to a private GitHub repo

Create an empty **private** repository on github.com named `binance-monitor` (no README), then:

```bash
cd ~/binance-monitor
git init
git add .
git status          # .env must NOT be in this list
git commit -m "Portfolio monitor"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/binance-monitor.git
git push -u origin main
```

`.env` is excluded by `.gitignore`, so your keys never go to GitHub.

## 3. Railway: backend and database

1. Sign in at **railway.com** with GitHub.
2. **New Project**, then **Deploy from GitHub repo**, then choose `binance-monitor`. Railway reads `railway.json` and builds the backend. The first build fails because variables are missing; that is expected.
3. In the project, click **+ Create**, then **Database**, then **PostgreSQL**.
4. Open the backend service, go to **Variables**, then **Raw Editor**, and paste (with your values):

   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   BINANCE_API_KEY=...
   BINANCE_API_SECRET=...
   API_TOKEN=...
   NTFY_TOPIC=...
   TIMEZONE=Asia/Karachi
   ```

   `${{Postgres.DATABASE_URL}}` is typed literally; Railway fills it in.
5. **Settings**, then **Region**: choose **EU West (Amsterdam)** or **Southeast Asia (Singapore)**. Not a US region: Binance blocks US servers.
6. **Settings**, then **Networking**, then **Generate Domain**. Copy the address, e.g. `https://binance-monitor-production.up.railway.app`.
7. Wait for the deploy to finish. In **Deploy Logs** look for `API key check passed` and `Backend listening`.
8. Open `https://YOUR-RAILWAY-ADDRESS/health` in a browser. You should see `{"ok":true,...}`.

If the logs say *Binance blocks requests from this server's location*, change the region in step 5 and redeploy.

## 4. Vercel: dashboard

1. Sign in at **vercel.com** with GitHub.
2. **Add New**, then **Project**, then import `binance-monitor`.
3. Set **Root Directory** to `apps/web`. The framework shows as Next.js.
4. Open **Environment Variables** and add:

   | Name | Value |
   | --- | --- |
   | `BACKEND_URL` | your Railway address from step 3.6 |
   | `API_TOKEN` | same as on Railway |
   | `DASHBOARD_PASSWORD` | your dashboard password |
   | `DASHBOARD_TOTP_SECRET` | the 2FA key from step 1 |
   | `SESSION_SECRET` | the random string from step 1 |

5. **Deploy**. Vercel gives you an address like `https://binance-monitor-abc.vercel.app`.
6. Open it on your phone, sign in with your password and the 6-digit code, and tap **Send a test alert**.

Optional: in the Vercel project, **Settings**, then **Functions**, set the region close to Railway (Frankfurt for Amsterdam, Singapore for Singapore). Pages load a little faster.

## 5. Finish up

1. **Dashboard button in alerts:** in Railway, add the variable `DASHBOARD_URL` with your Vercel address. Alerts then get an **Open dashboard** button.
2. **Stop the laptop copy** so you don't get every alert twice:

   ```bash
   cd ~/binance-monitor
   docker compose down
   ```

3. **Binance key:** Railway's outgoing IP address can change, so leave the key without an IP restriction. It is read-only, so it cannot trade or withdraw.

## Updating later

Push to GitHub and both services redeploy by themselves:

```bash
git add .
git commit -m "Describe the change"
git push
```

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Railway deploy fails with "Invalid configuration" | A variable in step 3.4 is missing or has a typo. The log lists which one. |
| Railway log: "API key has extra permissions" | Create a Binance key with only **Enable Reading**. |
| Dashboard says "Backend unreachable" | `BACKEND_URL` on Vercel must be the full `https://` Railway address, and `API_TOKEN` must match on both. |
| Dashboard shows "Unauthorized" | `API_TOKEN` differs between Railway and Vercel. |
| "Wrong password or code" | Check your phone's clock is set automatically; codes depend on the time. |
| No alerts arrive | Tap **Send a test alert**. If it fails, check `NTFY_TOPIC` on Railway matches the topic in the ntfy app. |
