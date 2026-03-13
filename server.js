require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app  = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TS_BASE   = 'https://api.tripleseat.com/v1';
const PORT      = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, '.data_cache.json');
const CACHE_TTL  = 60 * 60 * 1000; // 1 hour

// ─── In-memory cache ──────────────────────────────────────────────────────────
let cache = { data: null, fetchedAt: 0, status: 'idle' }; // status: idle|fetching|ready|error

// Load persisted cache from disk on startup
if (fs.existsSync(CACHE_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (saved.fetchedAt && (Date.now() - saved.fetchedAt) < CACHE_TTL) {
      cache = saved;
      console.log('📦 Loaded cached data from disk (age:', Math.round((Date.now() - saved.fetchedAt) / 60000), 'min)');
    }
  } catch {}
}

// ─── OAuth 2.0 Token ─────────────────────────────────────────────────────────
let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const resp = await axios.post('https://api.tripleseat.com/oauth/token', {
    client_id:     process.env.TRIPLESEAT_CLIENT_ID,
    client_secret: process.env.TRIPLESEAT_CLIENT_SECRET,
    grant_type:    'client_credentials',
  });
  tokenCache.token     = resp.data.access_token;
  tokenCache.expiresAt = Date.now() + 55 * 60 * 1000; // 55 min
  return tokenCache.token;
}

// ─── Parallel Paginated Fetcher ───────────────────────────────────────────────
// Fetches page 1 to learn total_pages, then fetches remaining pages in parallel
// batches of `concurrency`, respecting TripleSeat's 10 req/s rate limit.
async function fetchAll(endpoint, params = {}, concurrency = 5) {
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}` };

  const get = (page) =>
    axios.get(`${TS_BASE}/${endpoint}.json`, {
      headers,
      params: { ...params, page, per_page: 100 },
    }).then(r => r.data.results || []);

  // Page 1 tells us total_pages
  const firstPage = await axios.get(`${TS_BASE}/${endpoint}.json`, {
    headers,
    params: { ...params, page: 1, per_page: 100 },
  });
  const totalPages = firstPage.data.total_pages || 1;
  let results = firstPage.data.results || [];
  console.log(`  ${endpoint}: ${totalPages} pages to fetch…`);

  // Fetch remaining pages in batches
  for (let start = 2; start <= totalPages; start += concurrency) {
    const batch = [];
    for (let p = start; p < start + concurrency && p <= totalPages; p++) {
      batch.push(get(p));
    }
    const pages = await Promise.all(batch);
    pages.forEach(p => { results = results.concat(p); });
    // Throttle to ~5 req/s (well within the 10/s limit)
    if (start + concurrency <= totalPages) await sleep(200);
  }
  return results;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Parse budget env vars ─────────────────────────────────────────────────────
function parseBudgets(envKey) {
  return (process.env[envKey] || '').split(',').map(v => parseFloat(v.trim()) || 0);
}

// ─── Main data builder ────────────────────────────────────────────────────────
async function buildData() {
  console.log('🔄 Fetching all data from TripleSeat…');
  const t0 = Date.now();

  const [eventsRaw, leadsRaw, bookingsRaw] = await Promise.all([
    fetchAll('events', { show_financial: true }),
    fetchAll('leads'),
    fetchAll('bookings'),
  ]);
  console.log(`✅ Fetched ${eventsRaw.length} events, ${leadsRaw.length} leads, ${bookingsRaw.length} bookings in ${Math.round((Date.now()-t0)/1000)}s`);

  // ── Normalize events ────────────────────────────────────────────────────────
  const events = eventsRaw.map(ev => ({
    id:          ev.id,
    name:        ev.name || '',
    status:      (ev.status || '').toUpperCase(),
    lost_reason: '',
    date:        ev.event_date_iso8601 || ev.start_date || '',
    start_time:  ev.event_start_time || '',
    end_time:    ev.event_end_time || '',
    location:    ev.location?.name || '',
    event_style: ev.event_style || '',
    rooms:       Array.isArray(ev.rooms) ? ev.rooms.map(r => r.name).join(', ') : '',
    guests:      ev.guest_count || ev.guaranteed_guest_count || 0,
    type:        ev.event_type || '',
    owner:       ev.owner ? `${ev.owner.first_name} ${ev.owner.last_name}`.trim() : '',
    contact:     ev.contact ? `${ev.contact.first_name||''} ${ev.contact.last_name||''}`.trim() : '',
    grand_total: parseFloat(ev.grand_total || 0),
    paid_amount: parseFloat(ev.grand_total || 0) - parseFloat(ev.amount_due || 0),
    balance_due: parseFloat(ev.amount_due || 0),
    booking_id:  ev.booking_id || null,
  }));

  // ── Normalize leads ─────────────────────────────────────────────────────────
  const leads = leadsRaw.map(ld => ({
    id:           ld.id,
    first_name:   ld.first_name || '',
    last_name:    ld.last_name  || '',
    company:      ld.company    || '',
    email:        ld.email_address || '',
    phone:        ld.phone_number  || '',
    submitted:    ld.created_at    || '',
    converted:    ld.converted_at  || '',
    turned_down:  ld.turned_down_at || '',
    owner:        ld.owner ? `${ld.owner.first_name} ${ld.owner.last_name}`.trim() : '',
    location:     ld.location?.name || '',
    event_date:   ld.event_date || '',
    status: ld.converted_at   ? 'CONVERTED'
          : ld.turned_down_at ? 'LOST'
          : ld.deleted_at     ? 'DELETED'
          : 'OPEN',
  }));

  // ── Normalize bookings ──────────────────────────────────────────────────────
  const bookings = bookingsRaw.map(bk => ({
    id:          bk.id,
    name:        bk.name || '',
    status:      (bk.status || '').toUpperCase(),
    location:    bk.location?.name || '',
    total:       parseFloat(bk.total_grand_total || 0),
    start_date:  bk.start_date || '',
    owner:       bk.owner ? `${bk.owner.first_name} ${bk.owner.last_name}`.trim() : '',
  }));

  // ── Monthly pivot: budget targets + event revenue by status × year-month ───
  const STATUSES = ['CLOSED', 'DEFINITE', 'PROSPECT', 'TENTATIVE'];
  const monthlyPivot = {};

  // Inject budget targets
  ['2024','2025','2026','2027'].forEach(yr => {
    parseBudgets(`BUDGET_TARGETS_${yr}`).forEach((val, i) => {
      if (!val) return;
      const key = `${yr}-${String(i+1).padStart(2,'0')}`;
      if (!monthlyPivot[key]) monthlyPivot[key] = mkRow();
      monthlyPivot[key].BUDGET = val;
    });
  });

  events.forEach(ev => {
    if (!ev.date) return;
    const yr = ev.date.slice(0, 4);
    const mo = ev.date.slice(5, 7);
    const key = `${yr}-${mo}`;
    if (!monthlyPivot[key]) monthlyPivot[key] = mkRow();
    if (STATUSES.includes(ev.status)) monthlyPivot[key][ev.status] += ev.grand_total;
  });

  // ── Annual pivot ─────────────────────────────────────────────────────────────
  const annualPivot = {};
  events.forEach(ev => {
    const yr = ev.date?.slice(0,4);
    if (!yr) return;
    if (!annualPivot[yr]) annualPivot[yr] = mkRow();
    if (STATUSES.includes(ev.status)) annualPivot[yr][ev.status] += ev.grand_total;
  });
  ['2024','2025','2026','2027'].forEach(yr => {
    if (!annualPivot[yr]) annualPivot[yr] = mkRow();
    annualPivot[yr].BUDGET = parseBudgets(`BUDGET_TARGETS_${yr}`).reduce((a,v)=>a+v,0);
  });

  // ── Location / month pivot ────────────────────────────────────────────────
  const locationPivot = {};
  events.forEach(ev => {
    if (!ev.date || !ev.location) return;
    const yr = ev.date.slice(0,4);
    const mo = ev.date.slice(5,7);
    const key = `${yr}-${mo}`;
    if (!locationPivot[ev.location]) locationPivot[ev.location] = {};
    if (!locationPivot[ev.location][key]) locationPivot[ev.location][key] = mkRow();
    if (STATUSES.includes(ev.status)) locationPivot[ev.location][key][ev.status] += ev.grand_total;
  });

  // ── Owner / revenue pivot ────────────────────────────────────────────────────
  const ownerPivot = {};
  events.forEach(ev => {
    if (!ev.owner) return;
    if (!ownerPivot[ev.owner]) ownerPivot[ev.owner] = mkRow();
    if (STATUSES.includes(ev.status)) ownerPivot[ev.owner][ev.status] += ev.grand_total;
  });

  // ── KPIs ────────────────────────────────────────────────────────────────────
  const now     = new Date();
  const currYr  = String(now.getFullYear());
  const evtYear = events.filter(e => e.date?.startsWith(currYr));
  const ldsYear = leads.filter(l => l.submitted?.includes(String(currYr)));

  const kpis = {
    currentYear:      currYr,
    totalPipeline:    evtYear.reduce((s,e) => s + e.grand_total, 0),
    closedRevenue:    evtYear.filter(e=>e.status==='CLOSED').reduce((s,e)=>s+e.grand_total,0),
    definiteRevenue:  evtYear.filter(e=>e.status==='DEFINITE').reduce((s,e)=>s+e.grand_total,0),
    prospectRevenue:  evtYear.filter(e=>e.status==='PROSPECT').reduce((s,e)=>s+e.grand_total,0),
    tentativeRevenue: evtYear.filter(e=>e.status==='TENTATIVE').reduce((s,e)=>s+e.grand_total,0),
    totalEvents:      evtYear.length,
    closedEvents:     evtYear.filter(e=>e.status==='CLOSED').length,
    totalLeads:       ldsYear.length,
    convertedLeads:   ldsYear.filter(l=>l.status==='CONVERTED').length,
    conversionRate:   ldsYear.length ? Math.round(ldsYear.filter(l=>l.status==='CONVERTED').length / ldsYear.length * 1000) / 10 : 0,
    totalCollected:   events.reduce((s,e) => s + e.paid_amount, 0),
    totalOutstanding: events.reduce((s,e) => s + e.balance_due, 0),
  };

  // ── Leads by month (current year) ───────────────────────────────────────────
  const leadsMonthly = Array(12).fill(0);
  ldsYear.forEach(l => {
    const mo = parseInt(l.submitted?.split('/')[0] || '0', 10) - 1;
    if (mo >= 0) leadsMonthly[mo]++;
  });

  // ── Lead status breakdown ────────────────────────────────────────────────────
  const leadsByStatus = {};
  leads.forEach(l => { leadsByStatus[l.status] = (leadsByStatus[l.status] || 0) + 1; });

  // ── Top 10 closed events by revenue ─────────────────────────────────────────
  const topEvents = [...events]
    .filter(e => e.status==='CLOSED' && e.date?.startsWith(currYr))
    .sort((a,b) => b.grand_total - a.grand_total)
    .slice(0, 10);

  return {
    kpis, monthlyPivot, annualPivot, locationPivot, ownerPivot,
    leadsByStatus, leadsMonthly, topEvents,
    events, leads, bookings,
  };
}

function mkRow() { return { BUDGET: 0, CLOSED: 0, DEFINITE: 0, PROSPECT: 0, TENTATIVE: 0 }; }

// ─── Trigger fetch & cache ────────────────────────────────────────────────────
async function refreshCache(force = false) {
  if (cache.status === 'fetching') return;
  if (!force && cache.data && (Date.now() - cache.fetchedAt) < CACHE_TTL) return;
  cache.status = 'fetching';
  try {
    cache.data      = await buildData();
    cache.fetchedAt = Date.now();
    cache.status    = 'ready';
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    console.log('✅ Cache updated');
  } catch (err) {
    cache.status = 'error';
    cache.lastError = err.message;
    console.error('❌ Cache refresh failed:', err.message);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/api/data', async (req, res) => {
  const force = req.query.refresh === 'true';
  if (force) {
    await refreshCache(true);
  } else if (!cache.data) {
    await refreshCache(true);
  } else {
    // Return cached data immediately, refresh in background if stale
    if ((Date.now() - cache.fetchedAt) > CACHE_TTL) refreshCache(false);
  }
  if (cache.data) {
    res.json({ ...cache.data, _meta: { fetchedAt: cache.fetchedAt, status: cache.status } });
  } else {
    res.status(503).json({ error: 'Data not yet available. Status: ' + cache.status, detail: cache.lastError });
  }
});

app.get('/api/status', (_req, res) =>
  res.json({ status: cache.status, fetchedAt: cache.fetchedAt, age_minutes: Math.round((Date.now()-cache.fetchedAt)/60000) })
);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  TripleSeat Dashboard → http://localhost:${PORT}`);
  // Warm the cache on startup if stale/empty
  if (!cache.data || (Date.now() - cache.fetchedAt) > CACHE_TTL) {
    console.log('🔄 Warming cache in background…');
    refreshCache(true);
  }
});
