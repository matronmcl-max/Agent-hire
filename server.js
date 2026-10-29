// DotToDotDollars — Agent Hire API (prototype)
// The rails for AI agents to hire humans: post a job, fund escrow,
// verify completion, release payment. Platform takes a fee per job.
//
// PERSISTENCE — READ THIS BEFORE CHANGING THE DATABASE:
// Render's free web service has an ephemeral filesystem: a local
// data.db file is wiped on every restart/redeploy. That is why live
// jobs, members and stats previously vanished (all 0 after a deploy).
// This server therefore uses Turso (hosted libSQL, SQLite dialect)
// whenever TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are set, and
// falls back to the local better-sqlite3 file only when they are not.
// Set those two values as environment variables in the Render
// dashboard (never commit them to git) and the same tables survive
// restarts. See TURSO_SETUP.md for the exact setup steps.
// No token is logged at startup — only which backend is in use.

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());

const PLATFORM_FEE_RATE = 0.07; // 7% per completed job
const DEMO_GRANT = 1000;        // demo credits granted on agent registration

// ---------- Database ----------
const TURSO_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const USE_TURSO = Boolean(TURSO_URL && TURSO_TOKEN);

let tursoClient = null;
let localDb = null;
if (USE_TURSO) {
  // Lazy-require so a local-only checkout still runs without the dep.
  const { createClient } = require('@libsql/client');
  tursoClient = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
} else {
  const Database = require('better-sqlite3');
  localDb = new Database(path.join(__dirname, 'data.db'));
}

const DB_BACKEND = USE_TURSO ? 'turso' : 'local-sqlite';
console.log(`Database backend: ${DB_BACKEND}`);

// Normalize a libSQL row (array or object) into a plain object, and
// convert BigInt ids (AUTOINCREMENT) to Number so JSON responses match
// the old better-sqlite3 shapes exactly.
function normalizeRow(row, columns) {
  if (row == null) return undefined;
  const obj = {};
  if (Array.isArray(row)) {
    columns.forEach((col, i) => { obj[col] = row[i]; });
  } else {
    for (const key of Object.keys(row)) obj[key] = row[key];
  }
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'bigint') obj[key] = Number(obj[key]);
  }
  return obj;
}

async function dbAll(sql, args = []) {
  if (USE_TURSO) {
    const res = await tursoClient.execute({ sql, args });
    return res.rows.map((r) => normalizeRow(r, res.columns));
  }
  return localDb.prepare(sql).all(...args);
}

async function dbGet(sql, args = []) {
  const rows = await dbAll(sql, args);
  return rows[0];
}

async function dbRun(sql, args = []) {
  if (USE_TURSO) {
    await tursoClient.execute({ sql, args });
    return;
  }
  localDb.prepare(sql).run(...args);
}

// Run several writes atomically: a real transaction on Turso, and a
// better-sqlite3 transaction locally. steps = [{sql, args}, ...]
async function dbTx(steps) {
  if (USE_TURSO) {
    const tx = await tursoClient.transaction('write');
    try {
      for (const s of steps) await tx.execute({ sql: s.sql, args: s.args || [] });
      await tx.commit();
    } catch (e) {
      try { await tx.rollback(); } catch (_) {}
      throw e;
    } finally {
      try { tx.close(); } catch (_) {}
    }
    return;
  }
  const fn = localDb.transaction(() => {
    for (const s of steps) localDb.prepare(s.sql).run(...(s.args || []));
  });
  fn();
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    location TEXT DEFAULT '',
    contact TEXT DEFAULT '',
    payout INTEGER NOT NULL,
    fee INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    worker_id TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    released_at TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents(id),
    FOREIGN KEY (worker_id) REFERENCES workers(id)
  )`,
  `CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    actor_from TEXT,
    actor_to TEXT,
    amount INTEGER NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    contact TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL DEFAULT '/',
    referrer TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
];

async function initSchema() {
  for (const stmt of SCHEMA) await dbRun(stmt);
}

const now = () => new Date().toISOString();
const uid = (p) => p + '_' + crypto.randomBytes(8).toString('hex');

// ---------- Auth ----------
async function agentAuth(req, res, next) {
  try {
    const key = req.header('X-API-Key');
    if (!key) return res.status(401).json({ error: 'Missing X-API-Key header' });
    const agent = await dbGet('SELECT * FROM agents WHERE api_key = ?', [key]);
    if (!agent) return res.status(401).json({ error: 'Invalid API key' });
    req.agent = agent;
    next();
  } catch (e) {
    next(e);
  }
}

// ---------- Routes ----------

// Register an agent (demo: grants demo credits). In production this
// would sit behind signup + real payment.
app.post('/v1/agents/register', async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const agent = {
      id: uid('agt'),
      name,
      api_key: 'dtd_' + crypto.randomBytes(24).toString('hex'),
      balance: DEMO_GRANT,
      created_at: now(),
    };
    await dbTx([
      { sql: 'INSERT INTO agents (id, name, api_key, balance, created_at) VALUES (?, ?, ?, ?, ?)',
        args: [agent.id, agent.name, agent.api_key, agent.balance, agent.created_at] },
      { sql: `INSERT INTO ledger (job_id, actor_from, actor_to, amount, kind, created_at)
              VALUES (NULL, 'platform', ?, ?, 'demo_grant', ?)`,
        args: [agent.id, DEMO_GRANT, now()] },
    ]);
    res.status(201).json({ agent_id: agent.id, api_key: agent.api_key, balance: agent.balance });
  } catch (e) { next(e); }
});

// Agent posts a job: payout + platform fee are escrowed immediately.
// Optional: location (public area/neighborhood text) and contact (poster
// contact, revealed ONLY to the claiming worker — never on the public board).
app.post('/v1/jobs', agentAuth, async (req, res, next) => {
  try {
    const { title, description = '', payout, location = '', contact = '' } = req.body || {};
    if (!title || !Number.isInteger(payout) || payout <= 0) {
      return res.status(400).json({ error: 'title and positive integer payout are required' });
    }
    const fee = Math.max(1, Math.round(payout * PLATFORM_FEE_RATE));
    const total = payout + fee;
    if (req.agent.balance < total) {
      return res.status(402).json({ error: 'Insufficient balance', needed: total, balance: req.agent.balance });
    }
    const job = { id: uid('job'), agent_id: req.agent.id, title, description, payout, fee,
                  location: String(location).trim().slice(0, 120),
                  contact: String(contact).trim().slice(0, 120),
                  status: 'open', created_at: now() };
    await dbTx([
      { sql: 'UPDATE agents SET balance = balance - ? WHERE id = ?', args: [total, req.agent.id] },
      { sql: `INSERT INTO jobs (id, agent_id, title, description, location, contact, payout, fee, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        args: [job.id, job.agent_id, job.title, job.description, job.location, job.contact,
               job.payout, job.fee, job.created_at] },
      { sql: `INSERT INTO ledger (job_id, actor_from, actor_to, amount, kind, created_at)
              VALUES (?, ?, 'escrow', ?, 'escrow_hold', ?)`,
        args: [job.id, req.agent.id, total, now()] },
    ]);
    // Contact is never echoed back here: the claim response is the only place
    // it is ever returned.
    const { contact: _contact, ...jobOut } = job;
    res.status(201).json({ ...jobOut, escrowed: total });
  } catch (e) { next(e); }
});

// Public job board: what humans can browse and claim.
// Location is public; contact is NEVER included here.
app.get('/v1/jobs', async (req, res, next) => {
  try {
    const status = req.query.status || 'open';
    const jobs = await dbAll(`SELECT id, title, description, location, payout, fee, status, created_at
                             FROM jobs WHERE status = ? ORDER BY created_at DESC`, [status]);
    res.json({ jobs });
  } catch (e) { next(e); }
});

// Worker claims an open job.
app.post('/v1/jobs/:id/claim', async (req, res, next) => {
  try {
    const { worker_name } = req.body || {};
    if (!worker_name) return res.status(400).json({ error: 'worker_name is required' });
    const job = await dbGet('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'open') return res.status(409).json({ error: `Job is ${job.status}, not open` });

    let worker = await dbGet('SELECT * FROM workers WHERE name = ?', [worker_name]);
    const steps = [];
    if (!worker) {
      worker = { id: uid('wrk'), name: worker_name, balance: 0, created_at: now() };
      steps.push({ sql: 'INSERT INTO workers (id, name, balance, created_at) VALUES (?, ?, 0, ?)',
                   args: [worker.id, worker.name, worker.created_at] });
    }
    steps.push({ sql: "UPDATE jobs SET status = 'claimed', worker_id = ? WHERE id = ?",
                 args: [worker.id, job.id] });
    await dbTx(steps);
    // The claim response is the ONLY place the poster's contact is ever
    // returned: the claiming worker needs it to reach the poster for the
    // exact address. Location is public area-level text.
    res.json({ job_id: job.id, status: 'claimed', worker: worker.name,
               location: job.location || '', contact: job.contact || '' });
  } catch (e) { next(e); }
});

// Worker marks the job complete (agent then verifies + releases).
app.post('/v1/jobs/:id/complete', async (req, res, next) => {
  try {
    const { worker_name } = req.body || {};
    const job = await dbGet('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'claimed') return res.status(409).json({ error: `Job is ${job.status}, not claimed` });
    const worker = await dbGet('SELECT * FROM workers WHERE id = ?', [job.worker_id]);
    if (!worker || worker.name !== worker_name) {
      return res.status(403).json({ error: 'Only the claiming worker can complete this job' });
    }
    await dbRun("UPDATE jobs SET status = 'completed', completed_at = ? WHERE id = ?", [now(), job.id]);
    res.json({ job_id: job.id, status: 'completed', note: 'Awaiting agent verification and release' });
  } catch (e) { next(e); }
});

// Agent verifies and releases escrow: worker gets payout, platform keeps fee.
app.post('/v1/jobs/:id/release', agentAuth, async (req, res, next) => {
  try {
    const job = await dbGet('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.agent_id !== req.agent.id) return res.status(403).json({ error: 'Only the posting agent can release' });
    if (job.status !== 'completed') return res.status(409).json({ error: `Job is ${job.status}, not completed` });

    await dbTx([
      { sql: 'UPDATE workers SET balance = balance + ? WHERE id = ?', args: [job.payout, job.worker_id] },
      { sql: `INSERT INTO ledger (job_id, actor_from, actor_to, amount, kind, created_at)
              VALUES (?, 'escrow', ?, ?, 'payout', ?)`,
        args: [job.id, job.worker_id, job.payout, now()] },
      { sql: `INSERT INTO ledger (job_id, actor_from, actor_to, amount, kind, created_at)
              VALUES (?, 'escrow', 'platform', ?, 'fee', ?)`,
        args: [job.id, job.fee, now()] },
      { sql: "UPDATE jobs SET status = 'released', released_at = ? WHERE id = ?", args: [now(), job.id] },
    ]);
    res.json({ job_id: job.id, status: 'released', paid_to_worker: job.payout, platform_fee: job.fee });
  } catch (e) { next(e); }
});

// Agent wallet: balance + full ledger.
app.get('/v1/wallet', agentAuth, async (req, res, next) => {
  try {
    const agent = await dbGet('SELECT id, name, balance FROM agents WHERE id = ?', [req.agent.id]);
    const entries = await dbAll(`SELECT * FROM ledger WHERE actor_from = ? OR actor_to = ?
                                ORDER BY id DESC LIMIT 100`, [req.agent.id, req.agent.id]);
    res.json({ ...agent, ledger: entries });
  } catch (e) { next(e); }
});

// Club join: someone signs up via the landing page form.
app.post('/v1/join', async (req, res, next) => {
  try {
    const { name, contact } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    if (!contact || !String(contact).trim()) return res.status(400).json({ error: 'contact is required' });
    const member = { id: uid('mem'), name: String(name).trim().slice(0, 80),
                     contact: String(contact).trim().slice(0, 120), created_at: now() };
    await dbRun('INSERT INTO members (id, name, contact, created_at) VALUES (?, ?, ?, ?)',
                [member.id, member.name, member.contact, member.created_at]);
    res.status(201).json({ ok: true, member_id: member.id });
  } catch (e) { next(e); }
});

// List club signups (prototype: no auth — add some before going wide).
app.get('/v1/members', async (req, res, next) => {
  try {
    const members = await dbAll('SELECT id, name, contact, created_at FROM members ORDER BY created_at DESC');
    res.json({ count: members.length, members });
  } catch (e) { next(e); }
});

// Anonymous visit counter — logs page views, skips bots. No cookies, no personal data.
app.post('/v1/hit', async (req, res, next) => {
  try {
    const { path: p = '/', referrer = '' } = req.body || {};
    const ua = req.header('User-Agent') || '';
    if (/bot|crawl|spider|headless|monitor|uptime|pingdom|render/i.test(ua)) {
      return res.json({ ok: true, skipped: true });
    }
    await dbRun('INSERT INTO page_views (path, referrer, user_agent, created_at) VALUES (?, ?, ?, ?)',
                [String(p).slice(0, 200), String(referrer).slice(0, 300), ua.slice(0, 300), now()]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Traffic stats: total hits, hits by day (last 30), hits by path. Aggregates only.
app.get('/v1/stats', async (req, res, next) => {
  try {
    const totalRow = await dbGet('SELECT COUNT(*) AS c FROM page_views');
    const total = totalRow ? totalRow.c : 0;
    const byDay = await dbAll(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS hits
                              FROM page_views GROUP BY day ORDER BY day DESC LIMIT 30`);
    const byPath = await dbAll(`SELECT path, COUNT(*) AS hits FROM page_views
                               GROUP BY path ORDER BY hits DESC LIMIT 20`);
    res.json({ total, by_day: byDay, by_path: byPath });
  } catch (e) { next(e); }
});

// Health check (also reports which database backend is active — no secrets).
app.get('/v1/health', (req, res) => res.json({ ok: true, service: 'dottodotdollars-agent-hire', time: now(), db_backend: DB_BACKEND }));

// Landing page
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Human-readable traffic stats (aggregates only, from /v1/stats)
app.get('/stats', (req, res) => res.sendFile(path.join(__dirname, 'stats.html')));

// Proof page: completed / released jobs, anonymized, fee shown openly.
app.get('/proof', (req, res) => res.sendFile(path.join(__dirname, 'proof.html')));

// Service pages (SEO fishing lines)
app.get('/junk-removal-spokane', (req, res) => res.sendFile(path.join(__dirname, 'junk-removal-spokane.html')));
app.get('/moving-help-spokane', (req, res) => res.sendFile(path.join(__dirname, 'moving-help-spokane.html')));
app.get('/furniture-assembly-spokane', (req, res) => res.sendFile(path.join(__dirname, 'furniture-assembly-spokane.html')));
app.get('/meal-prep-spokane', (req, res) => res.sendFile(path.join(__dirname, 'meal-prep-spokane.html')));
app.get('/lawn-mowing-spokane', (req, res) => res.sendFile(path.join(__dirname, 'lawn-mowing-spokane.html')));
app.get('/snow-removal-spokane', (req, res) => res.sendFile(path.join(__dirname, 'snow-removal-spokane.html')));
app.get('/house-cleaning-spokane', (req, res) => res.sendFile(path.join(__dirname, 'house-cleaning-spokane.html')));
app.get('/pet-sitting-dog-walking-spokane', (req, res) => res.sendFile(path.join(__dirname, 'pet-sitting-dog-walking-spokane.html')));

// Sitemap + robots (served explicitly — no static middleware)
app.get('/sitemap.xml', (req, res) => res.sendFile(path.join(__dirname, 'sitemap.xml')));
app.get('/robots.txt', (req, res) => res.sendFile(path.join(__dirname, 'robots.txt')));

// Error handler: return JSON instead of an HTML stack trace.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
initSchema()
  .then(() => app.listen(PORT, () => console.log(`Agent Hire API listening on :${PORT} (db: ${DB_BACKEND})`)))
  .catch((e) => { console.error('Failed to initialise database:', e); process.exit(1); });
