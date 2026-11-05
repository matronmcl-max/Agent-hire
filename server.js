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
app.use('/images', express.static(path.join(__dirname, 'images')));

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
  `CREATE TABLE IF NOT EXISTS bridge_hands (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS seeking (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    rate TEXT DEFAULT '',
    location TEXT DEFAULT '',
    contact TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS board_posts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'other',
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    price TEXT DEFAULT '',
    location TEXT DEFAULT '',
    contact TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS trade_posts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'sell',
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    price TEXT DEFAULT '',
    location TEXT DEFAULT '',
    contact TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL
  )`,
  // Bids / counter-offers on a job. One open bid per worker per job;
  // a new bid replaces their old open one. status: open | accepted | declined
  `CREATE TABLE IF NOT EXISTS bids (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    worker_name TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id)
  )`,
];

async function initSchema() {
  for (const stmt of SCHEMA) await dbRun(stmt);
  // Existing live jobs table has no pricing_mode column: add it if missing.
  // pricing_mode: 'fixed' (poster sets price, default) or 'open_bid' (no price yet, workers bid).
  try { await dbRun("ALTER TABLE jobs ADD COLUMN pricing_mode TEXT DEFAULT 'fixed'"); } catch (_) {}
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
// pricing_mode: 'fixed' (default, payout required) or 'open_bid' — poster
// sets no price, workers bid, poster picks one. Open-bid jobs escrow
// nothing at posting; escrow locks when a bid is accepted.
app.post('/v1/jobs', agentAuth, async (req, res, next) => {
  try {
    const { title, description = '', payout, location = '', contact = '', pricing_mode = 'fixed' } = req.body || {};
    const mode = pricing_mode === 'open_bid' ? 'open_bid' : 'fixed';
    if (!title) return res.status(400).json({ error: 'title is required' });
    let pay = payout;
    if (mode === 'open_bid') {
      pay = 0;
    } else if (!Number.isInteger(pay) || pay <= 0) {
      return res.status(400).json({ error: 'title and positive integer payout are required' });
    }
    const fee = mode === 'open_bid' ? 0 : Math.max(1, Math.round(pay * PLATFORM_FEE_RATE));
    const total = pay + fee;
    if (req.agent.balance < total) {
      return res.status(402).json({ error: 'Insufficient balance', needed: total, balance: req.agent.balance });
    }
    const job = { id: uid('job'), agent_id: req.agent.id, title, description, payout: pay, fee,
                  location: String(location).trim().slice(0, 120),
                  contact: String(contact).trim().slice(0, 120),
                  status: 'open', pricing_mode: mode, created_at: now() };
    const steps = [];
    if (total > 0) {
      steps.push({ sql: 'UPDATE agents SET balance = balance - ? WHERE id = ?', args: [total, req.agent.id] });
    }
    steps.push({ sql: `INSERT INTO jobs (id, agent_id, title, description, location, contact, payout, fee, status, pricing_mode, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        args: [job.id, job.agent_id, job.title, job.description, job.location, job.contact,
               job.payout, job.fee, job.pricing_mode, job.created_at] });
    if (total > 0) {
      steps.push({ sql: `INSERT INTO ledger (job_id, actor_from, actor_to, amount, kind, created_at)
              VALUES (?, ?, 'escrow', ?, 'escrow_hold', ?)`,
        args: [job.id, req.agent.id, total, now()] });
    }
    await dbTx(steps);
    // Contact is never echoed back here: the claim response is the only place
    // it is ever returned.
    const { contact: _contact, ...jobOut } = job;
    res.status(201).json({ ...jobOut, escrowed: total });
  } catch (e) { next(e); }
});

// Seeking-work board: the reverse of the jobs board — a person posts
// the work they do and want to be hired for. Hires MUST go through
// the job flow (board -> job -> escrow -> 7%), so contact is NEVER
// handed out directly for a seeking post. A person who wants to hire
// them posts a job for that work; contact is shared only after the
// job is claimed, exactly like a job claim.
app.post('/v1/seeking', async (req, res, next) => {
  try {
    const { name, title, description = '', rate = '', location = '', contact = '' } = req.body || {};
    if (!name || !title || !contact) {
      return res.status(400).json({ error: 'name, title and contact are required' });
    }
    const post = { id: uid('seek'), name: String(name).trim().slice(0, 80),
                   title: String(title).trim().slice(0, 120),
                   description: String(description).trim().slice(0, 500),
                   rate: String(rate).trim().slice(0, 60),
                   location: String(location).trim().slice(0, 120),
                   contact: String(contact).trim().slice(0, 120),
                   status: 'open', created_at: now() };
    await dbRun(`INSERT INTO seeking (id, name, title, description, rate, location, contact, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      [post.id, post.name, post.title, post.description, post.rate, post.location, post.contact, post.created_at]);
    const { contact: _contact, ...postOut } = post;
    res.status(201).json(postOut);
  } catch (e) { next(e); }
});
app.get('/v1/seeking', async (req, res, next) => {
  try {
    const posts = await dbAll(`SELECT id, name, title, description, rate, location, status, created_at
                               FROM seeking WHERE status = 'open' ORDER BY created_at DESC`);
    res.json({ seeking: posts });
  } catch (e) { next(e); }
});
app.post('/v1/seeking/:id/contact', async (req, res, next) => {
  try {
    const post = await dbGet('SELECT * FROM seeking WHERE id = ?', [req.params.id]);
    if (!post) return res.status(404).json({ error: 'Seeking post not found' });
    if (post.status !== 'open') return res.status(409).json({ error: `Post is ${post.status}, not open` });
    // No direct contact for seeking work — hire through a job instead.
    return res.status(409).json({ error: 'Hire through a job — post a job for this person, and their contact is shared after the job is claimed.' });
  } catch (e) { next(e); }
});

// Buy & sell board: same shape as seeking work — a person posts an
// item to sell, or an item they want to buy. Public list never
// includes contact; it is returned only when someone asks for it.
app.post('/v1/trade', async (req, res, next) => {
  try {
    const { name, kind = 'sell', title, description = '', price = '', location = '', contact = '' } = req.body || {};
    if (!name || !title || !contact) {
      return res.status(400).json({ error: 'name, title and contact are required' });
    }
    const post = { id: uid('trd'), name: String(name).trim().slice(0, 80),
                   kind: kind === 'buy' ? 'buy' : 'sell',
                   title: String(title).trim().slice(0, 120),
                   description: String(description).trim().slice(0, 500),
                   price: String(price).trim().slice(0, 60),
                   location: String(location).trim().slice(0, 120),
                   contact: String(contact).trim().slice(0, 120),
                   status: 'open', created_at: now() };
    await dbRun(`INSERT INTO trade_posts (id, name, kind, title, description, price, location, contact, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      [post.id, post.name, post.kind, post.title, post.description, post.price, post.location, post.contact, post.created_at]);
    const { contact: _contact, ...postOut } = post;
    res.status(201).json(postOut);
  } catch (e) { next(e); }
});
app.get('/v1/trade', async (req, res, next) => {
  try {
    const posts = await dbAll(`SELECT id, name, kind, title, description, price, location, status, created_at
                               FROM trade_posts WHERE status = 'open' ORDER BY created_at DESC`);
    res.json({ trade: posts });
  } catch (e) { next(e); }
});
app.post('/v1/trade/:id/contact', async (req, res, next) => {
  try {
    const post = await dbGet('SELECT * FROM trade_posts WHERE id = ?', [req.params.id]);
    if (!post) return res.status(404).json({ error: 'Buy/sell post not found' });
    if (post.status !== 'open') return res.status(409).json({ error: `Post is ${post.status}, not open` });
    res.json({ id: post.id, name: post.name, contact: post.contact });
  } catch (e) { next(e); }
});

// General bulletin board: one board for everything — seeking work,
// for sale, wanted, or anything else. One form, one list.
// Contact rule, set Nov 5, 2026: SEEKING-WORK posts never give out
// contact directly — a hire has to go through a job (board -> job ->
// escrow -> 7%). Contact is shared only after that job is claimed.
// Sales / wanted / other posts are flow only (no fee on them), so
// their contact is still returned on tap.
app.post('/v1/board', async (req, res, next) => {
  try {
    const { name, kind = 'other', title, description = '', price = '', location = '', contact = '' } = req.body || {};
    if (!name || !title || !contact) {
      return res.status(400).json({ error: 'name, title and contact are required' });
    }
    const kinds = ['seeking', 'sell', 'buy', 'other'];
    const post = { id: uid('brd'), name: String(name).trim().slice(0, 80),
                   kind: kinds.includes(kind) ? kind : 'other',
                   title: String(title).trim().slice(0, 120),
                   description: String(description).trim().slice(0, 500),
                   price: String(price).trim().slice(0, 60),
                   location: String(location).trim().slice(0, 120),
                   contact: String(contact).trim().slice(0, 120),
                   status: 'open', created_at: now() };
    await dbRun(`INSERT INTO board_posts (id, name, kind, title, description, price, location, contact, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      [post.id, post.name, post.kind, post.title, post.description, post.price, post.location, post.contact, post.created_at]);
    const { contact: _contact, ...postOut } = post;
    res.status(201).json(postOut);
  } catch (e) { next(e); }
});
app.get('/v1/board', async (req, res, next) => {
  try {
    const posts = await dbAll(`SELECT id, name, kind, title, description, price, location, status, created_at
                               FROM board_posts WHERE status = 'open' ORDER BY created_at DESC`);
    res.json({ board: posts });
  } catch (e) { next(e); }
});
app.post('/v1/board/:id/contact', async (req, res, next) => {
  try {
    const post = await dbGet('SELECT * FROM board_posts WHERE id = ?', [req.params.id]);
    if (!post) return res.status(404).json({ error: 'Bulletin board post not found' });
    if (post.status !== 'open') return res.status(409).json({ error: `Post is ${post.status}, not open` });
    if (post.kind === 'seeking') {
      // No direct contact for seeking work — hire through a job instead.
      return res.status(409).json({ error: 'Hire through a job — post a job for this person, and their contact is shared after the job is claimed.' });
    }
    res.json({ id: post.id, name: post.name, contact: post.contact });
  } catch (e) { next(e); }
});

// Public job board: what humans can browse and claim.
// Location is public; contact is NEVER included here.
app.get('/v1/jobs', async (req, res, next) => {
  try {
    const status = req.query.status || 'open';
    const jobs = await dbAll(`SELECT id, title, description, location, payout, fee, status, pricing_mode, created_at
                             FROM jobs WHERE status = ? ORDER BY created_at DESC`, [status]);
    res.json({ jobs });
  } catch (e) { next(e); }
});

// Bids / counter-offers on an open job.
// Fixed-price job: a bid is a counter-offer. Open-bid job: a bid is a bid.
// One open bid per worker per job — a new bid replaces their old open one.
app.post('/v1/jobs/:id/bid', async (req, res, next) => {
  try {
    const { worker_name, amount } = req.body || {};
    if (!worker_name || !String(worker_name).trim()) return res.status(400).json({ error: 'worker_name is required' });
    if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive integer' });
    const job = await dbGet('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'open') return res.status(409).json({ error: `Job is ${job.status}, not open` });
    const name = String(worker_name).trim().slice(0, 80);
    const bid = { id: uid('bid'), job_id: job.id, worker_name: name, amount, status: 'open', created_at: now() };
    await dbTx([
      { sql: "UPDATE bids SET status = 'declined' WHERE job_id = ? AND worker_name = ? AND status = 'open'",
        args: [job.id, name] },
      { sql: 'INSERT INTO bids (id, job_id, worker_name, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [bid.id, bid.job_id, bid.worker_name, bid.amount, bid.status, bid.created_at] },
    ]);
    res.status(201).json(bid);
  } catch (e) { next(e); }
});

// List open bids on a job (public: worker names and amounts only, no contact).
app.get('/v1/jobs/:id/bids', async (req, res, next) => {
  try {
    const job = await dbGet('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const bids = await dbAll(`SELECT id, worker_name, amount, status, created_at FROM bids
                              WHERE job_id = ? ORDER BY created_at DESC`, [req.params.id]);
    res.json({ job_id: job.id, pricing_mode: job.pricing_mode || 'fixed', payout: job.payout, bids });
  } catch (e) { next(e); }
});

// Poster (posting agent only) accepts a bid / counter-offer.
// That bid's amount becomes the job price, payout + 7% fee are escrowed
// from the agent's balance, and the job becomes claimed by that worker.
app.post('/v1/jobs/:id/bids/:bidId/accept', agentAuth, async (req, res, next) => {
  try {
    const job = await dbGet('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.agent_id !== req.agent.id) return res.status(403).json({ error: 'Only the posting agent can accept a bid' });
    if (job.status !== 'open') return res.status(409).json({ error: `Job is ${job.status}, not open` });
    const bid = await dbGet('SELECT * FROM bids WHERE id = ? AND job_id = ?', [req.params.bidId, req.params.id]);
    if (!bid) return res.status(404).json({ error: 'Bid not found' });
    if (bid.status !== 'open') return res.status(409).json({ error: `Bid is ${bid.status}, not open` });
    const fee = Math.max(1, Math.round(bid.amount * PLATFORM_FEE_RATE));
    const total = bid.amount + fee;
    // Fixed-price jobs already escrowed their original payout at posting.
    // Accepting a counter-offer on one means: refund the old escrow, then
    // escrow the new amount. Open-bid jobs escrowed nothing yet.
    const alreadyEscrowed = job.payout + job.fee;
    const agent = await dbGet('SELECT * FROM agents WHERE id = ?', [req.agent.id]);
    if (agent.balance + alreadyEscrowed < total) {
      return res.status(402).json({ error: 'Insufficient balance', needed: total, balance: agent.balance + alreadyEscrowed });
    }
    let worker = await dbGet('SELECT * FROM workers WHERE name = ?', [bid.worker_name]);
    const steps = [];
    if (!worker) {
      worker = { id: uid('wrk'), name: bid.worker_name, balance: 0, created_at: now() };
      steps.push({ sql: 'INSERT INTO workers (id, name, balance, created_at) VALUES (?, ?, 0, ?)',
                   args: [worker.id, worker.name, worker.created_at] });
    }
    if (alreadyEscrowed > 0) {
      steps.push({ sql: 'UPDATE agents SET balance = balance + ? WHERE id = ?', args: [alreadyEscrowed, req.agent.id] });
      steps.push({ sql: `INSERT INTO ledger (job_id, actor_from, actor_to, amount, kind, created_at)
              VALUES (?, 'escrow', ?, ?, 'escrow_refund_counter', ?)`,
        args: [job.id, req.agent.id, alreadyEscrowed, now()] });
    }
    steps.push({ sql: 'UPDATE agents SET balance = balance - ? WHERE id = ?', args: [total, req.agent.id] });
    steps.push({ sql: `INSERT INTO ledger (job_id, actor_from, actor_to, amount, kind, created_at)
              VALUES (?, ?, 'escrow', ?, 'escrow_hold', ?)`,
      args: [job.id, req.agent.id, total, now()] });
    steps.push({ sql: "UPDATE bids SET status = 'accepted' WHERE id = ?", args: [bid.id] });
    steps.push({ sql: "UPDATE bids SET status = 'declined' WHERE job_id = ? AND status = 'open' AND id != ?",
      args: [job.id, bid.id] });
    steps.push({ sql: "UPDATE jobs SET payout = ?, fee = ?, pricing_mode = 'fixed', status = 'claimed', worker_id = ? WHERE id = ?",
      args: [bid.amount, fee, worker.id, job.id] });
    await dbTx(steps);
    res.json({ job_id: job.id, status: 'claimed', worker: worker.name, payout: bid.amount, fee,
               location: job.location || '', contact: job.contact || '' });
  } catch (e) { next(e); }
});

// Poster declines a bid / counter-offer.
app.post('/v1/jobs/:id/bids/:bidId/decline', agentAuth, async (req, res, next) => {
  try {
    const job = await dbGet('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.agent_id !== req.agent.id) return res.status(403).json({ error: 'Only the posting agent can decline a bid' });
    const bid = await dbGet('SELECT * FROM bids WHERE id = ? AND job_id = ?', [req.params.bidId, req.params.id]);
    if (!bid) return res.status(404).json({ error: 'Bid not found' });
    if (bid.status !== 'open') return res.status(409).json({ error: `Bid is ${bid.status}, not open` });
    await dbRun("UPDATE bids SET status = 'declined' WHERE id = ?", [bid.id]);
    res.json({ job_id: job.id, bid_id: bid.id, status: 'declined' });
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

// ---------- MCP wrapper (small, demo-only) ----------
// POST /mcp is a thin JSON-RPC wrapper around the existing /v1 routes.
// It adds NO new money logic and NO new auth bypass: post_job forwards
// to POST /v1/jobs with the caller's api_key as X-API-Key, so the
// existing agentAuth check still applies and anonymous posting is
// rejected. All balances here are DEMO CREDITS, not real money.
// Supported JSON-RPC methods: initialize, notifications/initialized,
// tools/list, tools/call, ping. GET /mcp is a human-readable info page.
const MCP_TOOLS = [
  {
    name: 'register_agent',
    description: 'Register a new AI agent. Grants 1000 DEMO credits only (not real money). Returns agent_id and api_key — keep the api_key secret.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Name for the agent' } },
      required: ['name'],
    },
  },
  {
    name: 'post_job',
    description: 'Post a job, escrowing payout + 7% fee in DEMO credits. Requires a valid api_key argument (from register_agent); anonymous posting is rejected. pricing_mode "fixed" (default, payout required) or "open_bid" (no price yet — workers bid, poster picks one, escrow locks on accept).',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Agent API key (never echoed back)' },
        title: { type: 'string' },
        description: { type: 'string' },
        payout: { type: 'integer', description: 'Payout in demo credits, positive integer (fixed jobs only)' },
        pricing_mode: { type: 'string', description: '"fixed" or "open_bid"' },
        location: { type: 'string', description: 'Public area/neighborhood text' },
        contact: { type: 'string', description: 'Poster contact, revealed only to the claiming worker' },
      },
      required: ['api_key', 'title'],
    },
  },
  {
    name: 'list_open_jobs',
    description: 'List open jobs on the public board. Location is public; contact details are never included.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'submit_bid',
    description: 'Bid on an open-bid job, or counter-offer on a fixed-price job. One open bid per worker per job; a new bid replaces their old open one. No auth needed.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        worker_name: { type: 'string' },
        amount: { type: 'integer', description: 'Bid amount in demo credits, positive integer' },
      },
      required: ['job_id', 'worker_name', 'amount'],
    },
  },
  {
    name: 'list_bids',
    description: 'List bids / counter-offers on a job. Worker names and amounts only, no contact.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
    },
  },
  {
    name: 'accept_bid',
    description: 'Posting agent accepts a bid / counter-offer. That amount becomes the job price, payout + 7% fee are escrowed in DEMO credits, and the job becomes claimed by that worker. Requires the posting agent api_key.',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Posting agent API key (never echoed back)' },
        job_id: { type: 'string' },
        bid_id: { type: 'string' },
      },
      required: ['api_key', 'job_id', 'bid_id'],
    },
  },
];

async function mcpForward(req, method, path, body, apiKey) {
  // Forward to the same server's existing /v1 route so all validation,
  // auth, escrow and privacy rules stay in exactly one place.
  const base = `${req.protocol}://${req.get('host')}`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  const upstream = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await upstream.json(); } catch (_) { data = null; }
  return { ok: upstream.ok, status: upstream.status, data };
}

function mcpTextResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function mcpErrorResult(message) {
  return { content: [{ type: 'text', text: String(message) }], isError: true };
}

app.get('/mcp', (req, res) => {
  const rows = MCP_TOOLS.map((t) => `<li><strong>${t.name}</strong> — ${t.description}</li>`).join('');
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>MCP — DotToDotDollars Agent Hire</title></head><body>
<h1>MCP endpoint: POST /mcp</h1>
<p><strong>DEMO CREDITS ONLY — NOT REAL MONEY.</strong> Jobs posted here use demo credits. No real dollars are held or paid out through this endpoint.</p>
<p>Send JSON-RPC 2.0 requests to POST /mcp with methods: initialize, tools/list, tools/call, ping. Posting a job requires a valid api_key argument; anonymous posting is rejected.</p>
<h2>Tools</h2><ul>${rows}</ul>
<p>Example initialize request body: {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"example-client","version":"1.0"}}}</p>
</body></html>`);
});

app.post('/mcp', async (req, res, next) => {
  try {
    const rpc = req.body || {};
    const { method, params = {}, id } = rpc;
    const isNotification = id === undefined || id === null;
    const ok = (result) => res.json({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });

    if (typeof method !== 'string') return fail(-32600, 'Invalid Request: method is required');

    if (method === 'notifications/initialized') {
      // MCP notification: no response body is expected.
      return res.status(202).end();
    }
    if (isNotification) return res.status(202).end();

    if (method === 'initialize') {
      return ok({
        protocolVersion: params.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dottodotdollars-agent-hire', version: '1.0.0' },
        instructions: 'DEMO CREDITS ONLY — NOT REAL MONEY. Tools: register_agent, post_job (requires api_key; fixed or open_bid), list_open_jobs, submit_bid, list_bids, accept_bid (requires posting api_key).',
      });
    }
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: MCP_TOOLS });

    if (method === 'tools/call') {
      const args = (params && params.arguments) || {};
      const name = params && params.name;
      if (name === 'register_agent') {
        if (!args.name || !String(args.name).trim()) return ok(mcpErrorResult('name is required'));
        const r = await mcpForward(req, 'POST', '/v1/agents/register', { name: args.name });
        return ok(r.ok ? mcpTextResult(r.data) : mcpErrorResult(r.data ? JSON.stringify(r.data) : `Upstream error ${r.status}`));
      }
      if (name === 'post_job') {
        if (!args.api_key) return ok(mcpErrorResult('api_key is required — posting anonymously is not allowed'));
        const mode = args.pricing_mode === 'open_bid' ? 'open_bid' : 'fixed';
        if (!args.title) return ok(mcpErrorResult('title is required'));
        if (mode === 'fixed' && (!Number.isInteger(args.payout) || args.payout <= 0)) {
          return ok(mcpErrorResult('title and positive integer payout are required for fixed-price jobs'));
        }
        const r = await mcpForward(req, 'POST', '/v1/jobs', {
          title: args.title, description: args.description || '', payout: args.payout || 0,
          pricing_mode: mode, location: args.location || '', contact: args.contact || '',
        }, args.api_key);
        // Upstream strips contact and never echoes the api_key; forward as-is.
        return ok(r.ok ? mcpTextResult(r.data) : mcpErrorResult(r.data ? JSON.stringify(r.data) : `Upstream error ${r.status}`));
      }
      if (name === 'list_open_jobs') {
        const r = await mcpForward(req, 'GET', '/v1/jobs?status=open');
        return ok(r.ok ? mcpTextResult(r.data) : mcpErrorResult(r.data ? JSON.stringify(r.data) : `Upstream error ${r.status}`));
      }
      if (name === 'submit_bid') {
        if (!args.job_id || !args.worker_name || !Number.isInteger(args.amount) || args.amount <= 0) {
          return ok(mcpErrorResult('job_id, worker_name and positive integer amount are required'));
        }
        const r = await mcpForward(req, 'POST', `/v1/jobs/${encodeURIComponent(args.job_id)}/bid`, {
          worker_name: args.worker_name, amount: args.amount,
        });
        return ok(r.ok ? mcpTextResult(r.data) : mcpErrorResult(r.data ? JSON.stringify(r.data) : `Upstream error ${r.status}`));
      }
      if (name === 'list_bids') {
        if (!args.job_id) return ok(mcpErrorResult('job_id is required'));
        const r = await mcpForward(req, 'GET', `/v1/jobs/${encodeURIComponent(args.job_id)}/bids`);
        return ok(r.ok ? mcpTextResult(r.data) : mcpErrorResult(r.data ? JSON.stringify(r.data) : `Upstream error ${r.status}`));
      }
      if (name === 'accept_bid') {
        if (!args.api_key || !args.job_id || !args.bid_id) {
          return ok(mcpErrorResult('api_key, job_id and bid_id are required'));
        }
        const r = await mcpForward(req, 'POST', `/v1/jobs/${encodeURIComponent(args.job_id)}/bids/${encodeURIComponent(args.bid_id)}/accept`, {}, args.api_key);
        return ok(r.ok ? mcpTextResult(r.data) : mcpErrorResult(r.data ? JSON.stringify(r.data) : `Upstream error ${r.status}`));
      }
      return ok(mcpErrorResult(`Unknown tool: ${name}`));
    }
    return fail(-32601, `Method not found: ${method}`);
  } catch (e) { next(e); }
});

// Landing page
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Human-readable traffic stats (aggregates only, from /v1/stats)
app.get('/stats', (req, res) => res.sendFile(path.join(__dirname, 'stats.html')));

// Proof page: completed / released jobs, anonymized, fee shown openly.
app.get('/proof', (req, res) => res.sendFile(path.join(__dirname, 'proof.html')));

// Gig ideas page: all job-suggestion cards, moved off the homepage.
app.get('/gig-ideas', (req, res) => res.sendFile(path.join(__dirname, 'gig-ideas.html')));

// Service pages (SEO fishing lines)
app.get('/junk-removal-spokane', (req, res) => res.sendFile(path.join(__dirname, 'junk-removal-spokane.html')));
app.get('/moving-help-spokane', (req, res) => res.sendFile(path.join(__dirname, 'moving-help-spokane.html')));
app.get('/furniture-assembly-spokane', (req, res) => res.sendFile(path.join(__dirname, 'furniture-assembly-spokane.html')));
app.get('/meal-prep-spokane', (req, res) => res.sendFile(path.join(__dirname, 'meal-prep-spokane.html')));
app.get('/lawn-mowing-spokane', (req, res) => res.sendFile(path.join(__dirname, 'lawn-mowing-spokane.html')));
app.get('/leaf-cleanup-spokane', (req, res) => res.sendFile(path.join(__dirname, 'leaf-cleanup-spokane.html')));
app.get('/snow-removal-spokane', (req, res) => res.sendFile(path.join(__dirname, 'snow-removal-spokane.html')));
app.get('/house-cleaning-spokane', (req, res) => res.sendFile(path.join(__dirname, 'house-cleaning-spokane.html')));
app.get('/pet-sitting-dog-walking-spokane', (req, res) => res.sendFile(path.join(__dirname, 'pet-sitting-dog-walking-spokane.html')));

// Bridge solo game, you as South + 3 bots. Engine: bridge-engine (MIT).
// Hands are persisted to the database (Turso live): a server restart
// restores the hand by replaying its recorded bids/plays, instead of
// wiping it. No money, no job routes touched.
const bridgeGame = require('./bridge-game');
bridgeGame.setSaveFn(async (snap) => {
  try {
    await dbRun(
      `INSERT INTO bridge_hands (id, state, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      [snap.id, JSON.stringify(snap), new Date().toISOString()]
    );
  } catch (e) { console.error('bridge save failed', e && e.message); }
});
async function getOrRestoreBridgeSession(id) {
  let session = bridgeGame.getSession(id);
  if (session) return session;
  try {
    const row = await dbGet('SELECT state FROM bridge_hands WHERE id = ?', [id]);
    if (!row) return null;
    const snap = JSON.parse(row.state);
    session = await bridgeGame.restoreSession(snap);
    // Give replay a tick to reach the saved point before serializing.
    await new Promise((r) => setTimeout(r, 100));
    return session;
  } catch (e) { console.error('bridge restore failed', e && e.message); return null; }
}
app.get('/bridge', (req, res) => res.sendFile(path.join(__dirname, 'bridge.html')));
app.get('/bridge.js', (req, res) => res.sendFile(path.join(__dirname, 'bridge.js')));
app.post('/v1/bridge/new', async (req, res, next) => {
  try {
    const session = bridgeGame.newSession();
    await bridgeGame.startSession(session);
    // Give the background loop a tick to reach the first human turn.
    await new Promise((r) => setTimeout(r, 50));
    res.json(bridgeGame.serialize(session));
  } catch (e) { next(e); }
});
app.get('/v1/bridge/state', async (req, res) => {
  const session = await getOrRestoreBridgeSession(req.query.session);
  if (!session) return res.status(404).json({ error: 'No such bridge game. Deal a new hand.' });
  res.json(bridgeGame.serialize(session));
});
app.post('/v1/bridge/bid', async (req, res) => {
  const session = await getOrRestoreBridgeSession(req.body.session);
  if (!session) return res.status(404).json({ error: 'No such bridge game. Deal a new hand.' });
  try { bridgeGame.submitBid(session, req.body.bid); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json(bridgeGame.serialize(session));
});
app.post('/v1/bridge/play', async (req, res) => {
  const session = await getOrRestoreBridgeSession(req.body.session);
  if (!session) return res.status(404).json({ error: 'No such bridge game. Deal a new hand.' });
  try { bridgeGame.submitPlay(session, req.body.card); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json(bridgeGame.serialize(session));
});
app.post('/v1/bridge/pause', async (req, res) => {
  const session = await getOrRestoreBridgeSession(req.body.session);
  if (!session) return res.status(404).json({ error: 'No such bridge game. Deal a new hand.' });
  bridgeGame.setPaused(session, req.body.paused);
  res.json(bridgeGame.serialize(session));
});

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
