#!/usr/bin/env node
/**
 * build-data.js
 * Fetches all TripleSeat data and writes public/data.json
 *
 * Usage:  node scripts/build-data.js
 * Env:    TRIPLESEAT_CLIENT_ID, TRIPLESEAT_CLIENT_SECRET
 *         Optionally: BUDGET_TARGETS_2025, BUDGET_TARGETS_2026, BUDGET_TARGETS_2027
 */
require('dotenv').config();
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const TS_BASE = 'https://api.tripleseat.com/v1';
const OUT     = path.join(__dirname, '..', 'docs', 'data.json');

// ─── OAuth Token ──────────────────────────────────────────────────────────────
let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const resp = await axios.post('https://api.tripleseat.com/oauth/token', {
    client_id:     process.env.TRIPLESEAT_CLIENT_ID,
    client_secret: process.env.TRIPLESEAT_CLIENT_SECRET,
    grant_type:    'client_credentials',
  });
  tokenCache.token     = resp.data.access_token;
  tokenCache.expiresAt = Date.now() + 55 * 60 * 1000;
  return tokenCache.token;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Single GET with exponential-backoff retry on 429
async function getWithRetry(url, options, maxRetries = 8) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await axios.get(url, options);
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < maxRetries) {
        // Honour Retry-After header if present, else exponential back-off
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '0', 10);
        const wait = retryAfter > 0
          ? retryAfter * 1000
          : Math.min(2000 * Math.pow(2, attempt), 60000); // 2s, 4s, 8s … 60s cap
        console.log(`  ⚠️  429 on ${url} — waiting ${wait / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
        await sleep(wait);
      } else {
        throw err;
      }
    }
  }
}

// ─── Paginated Fetcher ────────────────────────────────────────────────────────
// Fetches one page at a time (concurrency=1) with a 350ms pause between pages.
// Handles 429 via getWithRetry. Safe for TripleSeat's rate limits regardless
// of account tier.
async function fetchAll(endpoint, params = {}) {
  const token   = await getToken();
  const headers = { Authorization: `Bearer ${token}` };

  const get = p => getWithRetry(`${TS_BASE}/${endpoint}.json`, {
    headers, params: { ...params, page: p, per_page: 100 },
  }).then(r => r.data.results || []);

  const first = await getWithRetry(`${TS_BASE}/${endpoint}.json`, {
    headers, params: { ...params, page: 1, per_page: 100 },
  });
  const totalPages = first.data.total_pages || 1;
  let results = first.data.results || [];
  console.log(`  ${endpoint}: ${totalPages} page(s)…`);

  for (let p = 2; p <= totalPages; p++) {
    await sleep(350); // ~3 req/s — well within TripleSeat's limit
    results = results.concat(await get(p));
    if (p % 20 === 0) console.log(`    ${endpoint}: page ${p}/${totalPages}`);
  }
  return results;
}

// ─── Budget parser ────────────────────────────────────────────────────────────
function parseBudgets(envKey) {
  return (process.env[envKey] || '').split(',').map(v => parseFloat(v.trim()) || 0);
}

function mkRow() { return { BUDGET: 0, CLOSED: 0, DEFINITE: 0, PROSPECT: 0, TENTATIVE: 0 }; }

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.TRIPLESEAT_CLIENT_ID || !process.env.TRIPLESEAT_CLIENT_SECRET) {
    console.error('❌ Missing TRIPLESEAT_CLIENT_ID or TRIPLESEAT_CLIENT_SECRET');
    process.exit(1);
  }

  console.log('🔄 Fetching TripleSeat data (sequential to respect rate limits)…');
  const t0 = Date.now();

  // Fetch sequentially — max 3 concurrent requests at any time
  const eventsRaw   = await fetchAll('events', { show_financial: true });
  const leadsRaw    = await fetchAll('leads');
  const bookingsRaw = await fetchAll('bookings');

  console.log(`✅ ${eventsRaw.length} events, ${leadsRaw.length} leads, ${bookingsRaw.length} bookings in ${Math.round((Date.now()-t0)/1000)}s`);

  // ── Normalize ──────────────────────────────────────────────────────────────
  const events = eventsRaw.map(ev => ({
    id:          ev.id,
    name:        ev.name || '',
    status:      (ev.status || '').toUpperCase(),
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

  const bookings = bookingsRaw.map(bk => ({
    id:         bk.id,
    name:       bk.name || '',
    status:     (bk.status || '').toUpperCase(),
    location:   bk.location?.name || '',
    total:      parseFloat(bk.total_grand_total || 0),
    start_date: bk.start_date || '',
    owner:      bk.owner ? `${bk.owner.first_name} ${bk.owner.last_name}`.trim() : '',
  }));

  // ── Pivots ────────────────────────────────────────────────────────────────
  const STATUSES = ['CLOSED', 'DEFINITE', 'PROSPECT', 'TENTATIVE'];
  const monthlyPivot = {};

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
    const key = `${ev.date.slice(0,4)}-${ev.date.slice(5,7)}`;
    if (!monthlyPivot[key]) monthlyPivot[key] = mkRow();
    if (STATUSES.includes(ev.status)) monthlyPivot[key][ev.status] += ev.grand_total;
  });

  const annualPivot = {};
  events.forEach(ev => {
    const yr = ev.date?.slice(0,4); if (!yr) return;
    if (!annualPivot[yr]) annualPivot[yr] = mkRow();
    if (STATUSES.includes(ev.status)) annualPivot[yr][ev.status] += ev.grand_total;
  });
  ['2024','2025','2026','2027'].forEach(yr => {
    if (!annualPivot[yr]) annualPivot[yr] = mkRow();
    annualPivot[yr].BUDGET = parseBudgets(`BUDGET_TARGETS_${yr}`).reduce((a,v)=>a+v,0);
  });

  const locationPivot = {};
  events.forEach(ev => {
    if (!ev.date || !ev.location) return;
    const key = `${ev.date.slice(0,4)}-${ev.date.slice(5,7)}`;
    if (!locationPivot[ev.location]) locationPivot[ev.location] = {};
    if (!locationPivot[ev.location][key]) locationPivot[ev.location][key] = mkRow();
    if (STATUSES.includes(ev.status)) locationPivot[ev.location][key][ev.status] += ev.grand_total;
  });

  const ownerPivot = {};
  events.forEach(ev => {
    if (!ev.owner) return;
    if (!ownerPivot[ev.owner]) ownerPivot[ev.owner] = mkRow();
    if (STATUSES.includes(ev.status)) ownerPivot[ev.owner][ev.status] += ev.grand_total;
  });

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const currYr  = String(new Date().getFullYear());
  const evtYear = events.filter(e => e.date?.startsWith(currYr));
  const ldsYear = leads.filter(l => l.submitted?.includes(currYr));

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
    conversionRate:   ldsYear.length ? Math.round(ldsYear.filter(l=>l.status==='CONVERTED').length/ldsYear.length*1000)/10 : 0,
    totalCollected:   events.reduce((s,e) => s + e.paid_amount, 0),
    totalOutstanding: events.reduce((s,e) => s + e.balance_due, 0),
  };

  const leadsMonthly = Array(12).fill(0);
  ldsYear.forEach(l => {
    const mo = parseInt(l.submitted?.split('/')[0] || '0', 10) - 1;
    if (mo >= 0) leadsMonthly[mo]++;
  });

  const leadsByStatus = {};
  leads.forEach(l => { leadsByStatus[l.status] = (leadsByStatus[l.status] || 0) + 1; });

  const topEvents = [...events]
    .filter(e => e.status==='CLOSED' && e.date?.startsWith(currYr))
    .sort((a,b) => b.grand_total - a.grand_total)
    .slice(0, 10);

  // ── Write output ──────────────────────────────────────────────────────────
  const output = {
    _meta: { fetchedAt: Date.now(), status: 'ready' },
    kpis, monthlyPivot, annualPivot, locationPivot, ownerPivot,
    leadsByStatus, leadsMonthly, topEvents,
    events, leads, bookings,
  };

  const json = JSON.stringify(output);
  fs.writeFileSync(OUT, json);
  console.log(`✅ Wrote public/data.json (${Math.round(Buffer.byteLength(json) / 1024 / 1024 * 10)/10} MB)`);
}

main().catch(err => {
  console.error('❌ Build failed:', err.message);
  process.exit(1);
});
