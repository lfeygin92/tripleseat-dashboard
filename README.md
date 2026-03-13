# TripleSeat Sales Dashboard

A live, auto-refreshing sales dashboard for weekly leadership reviews — built on the TripleSeat API.

## What it shows

- **KPI cards** — Total pipeline, closed revenue, definite/prospect/tentative breakdown, YTD leads, collected payments, outstanding balance
- **Monthly revenue chart** — Stacked bar by status (Closed, Definite, Prospect, Tentative) with optional Budget line
- **Annual comparison** — Year-over-year revenue by status
- **Revenue by location** — Doughnut chart of pipeline share per venue
- **Lead volume** — Monthly bar chart of inbound leads (current year)
- **Lead status breakdown** — Converted, Lost, etc.
- **Payment methods** — Credit Card vs Wire Transfer vs Check
- **Top 10 closed events** by revenue
- **Full events table** — filterable by year, location, and status

---

## Local setup

### 1. Prerequisites
- Node.js 18 or later — https://nodejs.org

### 2. Install
```bash
cd tripleseat-dashboard
npm install
```

### 3. Configure credentials
Copy `.env.example` to `.env` and fill in your values (already done if you received the pre-configured `.env` file):

```bash
cp .env.example .env
```

**Required fields in `.env`:**
```
TRIPLESEAT_CLIENT_ID=your_client_id
TRIPLESEAT_CLIENT_SECRET=your_client_secret
```

**Optional — add monthly budget targets** to show the Budget line on the monthly chart:
```
BUDGET_TARGETS_2026=300000,300000,800000,900000,1100000,1200000,900000,800000,1300000,1300000,600000,400000
```
Values are comma-separated Jan–Dec dollar amounts (no $ sign, no commas within numbers).

### 4. Run
```bash
npm start
```

Open your browser to **http://localhost:3000**

For development with auto-restart on file changes:
```bash
npm run dev
```

---

## Deploying to the web (optional)

### Option A — Railway (easiest, ~$5/mo)
1. Push this repo to GitHub (the `.env` file is gitignored — add env vars in Railway's dashboard)
2. Go to https://railway.app → New Project → Deploy from GitHub repo
3. Add environment variables: `TRIPLESEAT_CLIENT_ID`, `TRIPLESEAT_CLIENT_SECRET`, and any `BUDGET_TARGETS_*`
4. Railway auto-detects Node.js and deploys — you'll get a public URL

### Option B — Render (free tier available)
1. Push repo to GitHub
2. Go to https://render.com → New Web Service → connect repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add environment variables in the Render dashboard

### Option C — Heroku
1. Push repo to GitHub
2. `heroku create your-app-name`
3. `heroku config:set TRIPLESEAT_CLIENT_ID=xxx TRIPLESEAT_CLIENT_SECRET=xxx`
4. `git push heroku main`

---

## Security notes

- **Never commit `.env`** — it's in `.gitignore` for a reason
- When deploying, always set credentials as environment variables in your hosting platform's dashboard, not in code
- The dashboard has no authentication by default — if deploying publicly, add HTTP Basic Auth or restrict access by IP

---

## TripleSeat OAuth note

These credentials use **OAuth 2.0** (Client ID + Client Secret). TripleSeat's legacy OAuth 1.0 (Consumer Key/Secret) is being sunset on **July 1, 2026**. If you have old integrations using OAuth 1.0, migrate them before that date via Settings → API/Webhooks in TripleSeat.

---

## Customising the budget line

The "Budget" line on the monthly chart is driven by the `BUDGET_TARGETS_YYYY` env vars. These are not pulled from TripleSeat automatically — they reflect your internal sales targets. Update them each year in `.env` (local) or in your hosting platform's env var settings (deployed).

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `401 Unauthorized` | Check `TRIPLESEAT_CLIENT_ID` and `TRIPLESEAT_CLIENT_SECRET` in `.env` |
| Charts show no data | Confirm your TripleSeat account has events — check the `/api/data` endpoint directly |
| `ECONNREFUSED` on start | Make sure you ran `npm install` first |
| Stale data | Click the **↻ Refresh** button — data is fetched live on each page load |
