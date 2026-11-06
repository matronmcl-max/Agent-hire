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
// Behind Render's proxy: trust X-Forwarded-For (first hop) so req.ip is
// the real client IP — the rate limiter below depends on it.
app.set('trust proxy', 1);
app.use(express.json());
// Malformed JSON bodies get a 400 (not a 500). For POST /mcp the
// JSON-RPC parse error -32700 applies instead (C4, audit Nov 5-6).
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    if (req.path === '/mcp') {
      return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: invalid JSON' } });
    }
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  next(err);
});
app.use('/images', express.static(path.join(__dirname, 'images')));

const PLATFORM_FEE_RATE = 0.07; // 7% per completed job
// MONEY IS INTEGER CENTS (100 cents = $1), Nov 6 2026. The 7% fee is
// split evenly between poster and worker, so halves must be exact to
// the cent — whole dollars could not hold a $3.50 half. Fee F =
// max(100, round(payout * 0.07)) cents. Poster pays payout +
// ceil(F/2); worker gets payout - floor(F/2); club keeps F exactly.
// When F is odd in cents the poster pays the extra cent.
const CENTS_PER_DOLLAR = 100;
const MIN_FEE_CENTS = 100; // $1 minimum fee
const DEMO_GRANT = 100000;  // 100,000 demo cents = $1,000 on agent registration
function feeForCents(payoutCents) { return Math.max(MIN_FEE_CENTS, Math.round(payoutCents * PLATFORM_FEE_RATE)); }
function posterShareCents(feeCents) { return Math.ceil(feeCents / 2); }
function workerShareCents(feeCents) { return Math.floor(feeCents / 2); }
function escrowForCents(payoutCents, feeCents) { return payoutCents + posterShareCents(feeCents); }
function workerGetsCents(payoutCents, feeCents) { return payoutCents - workerShareCents(feeCents); }
// Attach the split to a job row for API responses (all amounts cents).
function withSplit(job) {
  if (!job || job.payout == null || job.fee == null) return job;
  const pay = Number(job.payout), fee = Number(job.fee);
  return { ...job, poster_pays: escrowForCents(pay, fee), worker_gets: workerGetsCents(pay, fee) };
}

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
    api_key TEXT UNIQUE,
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
    escrowed INTEGER NOT NULL DEFAULT 0,
    manage_code TEXT,
    claim_code TEXT,
    claim_contact TEXT DEFAULT '',
    is_new_member INTEGER NOT NULL DEFAULT 0,
    new_member_until TEXT DEFAULT '',
    new_member_label TEXT DEFAULT '',
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
    username TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL DEFAULT '/',
    referrer TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
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
    created_at TEXT NOT NULL,
    is_new_member INTEGER NOT NULL DEFAULT 0,
    new_member_until TEXT DEFAULT '',
    new_member_label TEXT DEFAULT ''
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
  // Suggestions + bug reports from visitors. Nothing in these tables
  // is ever listed publicly — no GET endpoint exposes them, and any
  // contact left here stays private (same rule as member contacts).
  `CREATE TABLE IF NOT EXISTS suggestions (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    category TEXT DEFAULT '',
    name TEXT DEFAULT '',
    contact TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    read_at TEXT DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS bug_reports (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    page TEXT DEFAULT '',
    trying_to_do TEXT DEFAULT '',
    device TEXT DEFAULT '',
    name TEXT DEFAULT '',
    contact TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    read_at TEXT DEFAULT ''
  )`,
];

// One-time migration: whole dollars -> integer cents (Nov 6 2026).
// Guarded by meta.money_unit so it runs once. Live DBs had no real
// paid jobs; local test DBs were empty. Released jobs are history —
// their money already moved, leave them alone. For open/claimed/
// completed agent jobs the old model had already charged the poster
// payout+fee; the new model charges payout + ceil(fee/2), so refund
// the overcharged floor(fee/2) to the agent and set escrowed to the
// new amount. Website jobs hold nothing and are untouched.
async function migrateMoneyToCents() {
  let flag = null;
  try { flag = await dbGet("SELECT value FROM meta WHERE key = 'money_unit'"); } catch (_) {}
  if (flag && flag.value === 'cents') return;
  const steps = [];
  for (const [table, cols] of [
    ['agents', ['balance']], ['workers', ['balance']],
    ['jobs', ['payout', 'fee', 'escrowed']], ['bids', ['amount']], ['ledger', ['amount']],
  ]) {
    for (const col of cols) steps.push({ sql: `UPDATE ${table} SET ${col} = ${col} * 100`, args: [] });
  }
  await dbTx(steps);
  let legacyJobs = [];
  try {
    legacyJobs = await dbAll(`SELECT * FROM jobs WHERE agent_id != 'agt_website'
                              AND status IN ('open','claimed','completed') AND (payout + fee) > 0`);
  } catch (_) {}
  const fixSteps = [];
  for (const job of legacyJobs) {
    const held = Number(job.escrowed || 0);
    if (held <= 0) continue; // never held anything; backfill below covers it
    const fee = Number(job.fee || 0), pay = Number(job.payout || 0);
    const over = Math.floor(fee / 2); // overcharged half under the old model
    const newEscrowed = pay + Math.ceil(fee / 2);
    if (over > 0) {
      fixSteps.push({ sql: 'UPDATE agents SET balance = balance + ? WHERE id = ?', args: [over, job.agent_id] });
      fixSteps.push({ sql: `INSERT INTO ledger (job_id, actor_from, actor_to, amount, kind, created_at)
                    VALUES (?, 'escrow', ?, ?, 'fee_split_migration_refund', ?)`,
        args: [job.id, job.agent_id, over, now()] });
    }
    fixSteps.push({ sql: 'UPDATE jobs SET escrowed = ? WHERE id = ?', args: [newEscrowed, job.id] });
  }
  if (fixSteps.length) await dbTx(fixSteps);
  try {
    await dbRun("INSERT INTO meta (key, value) VALUES ('money_unit', 'cents')");
  } catch (_) {
    await dbRun("UPDATE meta SET value = 'cents' WHERE key = 'money_unit'");
  }
}

async function initSchema() {
  for (const stmt of SCHEMA) await dbRun(stmt);
  // Existing live jobs table has no pricing_mode column: add it if missing.
  // pricing_mode: 'fixed' (poster sets price, default) or 'open_bid' (no price yet, workers bid).
  try { await dbRun("ALTER TABLE jobs ADD COLUMN pricing_mode TEXT DEFAULT 'fixed'"); } catch (_) {}
  // Audit Nov 5-6: per-job escrow tracking + poster/claim codes.
  // These ALTERs are no-ops on fresh DBs (columns already in SCHEMA)
  // and add the columns to existing DBs; errors mean "already exists".
  for (const col of [
    'ALTER TABLE jobs ADD COLUMN escrowed INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE jobs ADD COLUMN manage_code TEXT',
    'ALTER TABLE jobs ADD COLUMN claim_code TEXT',
    "ALTER TABLE jobs ADD COLUMN claim_contact TEXT DEFAULT ''",
    // New-member gratitude highlight (Nov 6 2026): flag + window end +
    // badge label stored at post time; GET endpoints recompute the
    // live status from new_member_until so expiry is automatic.
    'ALTER TABLE jobs ADD COLUMN is_new_member INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE jobs ADD COLUMN new_member_until TEXT DEFAULT ''",
    "ALTER TABLE jobs ADD COLUMN new_member_label TEXT DEFAULT ''",
    'ALTER TABLE board_posts ADD COLUMN is_new_member INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE board_posts ADD COLUMN new_member_until TEXT DEFAULT ''",
    "ALTER TABLE board_posts ADD COLUMN new_member_label TEXT DEFAULT ''",
    // Optional username / tag (Nov 6 2026): nullable, unique
    // case-insensitively (see the unique index below). Existing
    // members keep NULL — no forced change, no migration breakage.
    'ALTER TABLE members ADD COLUMN username TEXT',
    // Admin inbox (Nov 6 2026): read marker for suggestions/bugs.
    'ALTER TABLE suggestions ADD COLUMN read_at TEXT DEFAULT \'\'',
    'ALTER TABLE bug_reports ADD COLUMN read_at TEXT DEFAULT \'\'',
  ]) { try { await dbRun(col); } catch (_) {} }
  // One tag per member, first come first served — case-insensitive.
  // NULLs stay distinct in SQLite, so members without a tag are fine.
  try { await dbRun('CREATE UNIQUE INDEX IF NOT EXISTS idx_members_username_lower ON members (LOWER(username))'); } catch (_) {}
  // Money moved to integer cents (see migrateMoneyToCents above).
  await migrateMoneyToCents();
  // Backfill escrowed for legacy agent jobs that somehow still show 0
  // held: new split model — poster pays payout + ceil(fee/2).
  // Website jobs hold nothing (escrowed stays 0).
  try {
    await dbRun(`UPDATE jobs SET escrowed = payout + (fee + 1) / 2 WHERE escrowed = 0
                 AND agent_id != 'agt_website' AND status IN ('open','claimed','completed')
                 AND (payout + fee) > 0`);
  } catch (_) {}
  await ensureWebsiteAgent();
}

const now = () => new Date().toISOString();
const uid = (p) => p + '_' + crypto.randomBytes(8).toString('hex');
// Random per-job codes. manage_code (12 hex chars) is issued once when a
// human posts a job; claim_code (6 hex chars) is issued once on claim.
const newManageCode = () => crypto.randomBytes(6).toString('hex');
const newClaimCode = () => crypto.randomBytes(3).toString('hex');
// Constant-time code comparison (both sides must be non-empty strings).
function codesEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---------- New-member gratitude highlight (Nov 6 2026) ----------
// A member is "new" for their first 30 days after joining. Their job
// and bulletin-board posts get a "New — joined Mon YYYY" badge and
// sort to the top of the lists. The window runs from the FIRST join
// only: re-joining never restarts it. Matching is by contact (trimmed,
// case-insensitive) — the human-jobs form collects contact, not name,
// so contact is the identifier that both post forms share. The badge
// is only ever attached to a post the member made; there is NO public
// member list (GET /v1/members stays deleted) and no member names or
// contacts are published anywhere.
const NEW_MEMBER_DAYS = 30;
function normContact(c) { return String(c || '').trim().toLowerCase(); }
async function earliestMemberByContact(contact) {
  const n = normContact(contact);
  if (!n) return null;
  return dbGet(`SELECT * FROM members WHERE LOWER(TRIM(contact)) = ? ORDER BY created_at ASC LIMIT 1`, [n]);
}
// If this member is still inside their first 30 days, the badge window
// for a post they make now. Returns null once the 30 days are up.
function newMemberWindow(member) {
  if (!member || !member.created_at) return null;
  const joined = new Date(member.created_at);
  if (isNaN(joined.getTime())) return null;
  const until = new Date(joined.getTime() + NEW_MEMBER_DAYS * 24 * 60 * 60 * 1000);
  if (until <= new Date()) return null;
  const label = 'New — joined ' + joined.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  return { until: until.toISOString(), label };
}
// Live badge status for a stored row: the stored flag says the poster
// WAS new when they posted; the window end says whether they still are.
// Expiry is automatic — no cron, no manual removal.
function withNewMember(row) {
  if (!row) return row;
  const live = Boolean(row.is_new_member) && row.new_member_until && row.new_member_until > now();
  return { ...row, is_new_member: live, new_member_until: live ? row.new_member_until : null,
           new_member_label: live ? (row.new_member_label || 'New member') : null };
}

// ---------- Optional username / tag (Nov 6 2026) ----------
// Members may pick a public tag at Join (e.g. @LeafKing). It is
// optional: blank means their first name shows on posts instead.
// The tag is the public face — the member's real name and contact
// stay private either way. One tag per person, first come first
// served; set at Join, never changeable through any public form.
// Stored WITHOUT the @, shown WITH it. Uniqueness is
// case-insensitive (@LeafKing and @leafking are the same tag).
// Reserved words, in one place here: tags that could make a poster
// look like the site itself (admin, the founder, the club) are refused.
const RESERVED_USERNAMES = ['admin', 'mat', 'dottodotdollars', 'support', 'club'];
function normalizeUsername(raw) {
  return String(raw || '').trim().replace(/^@+/, '').toLowerCase();
}
function validateUsername(raw) {
  const u = normalizeUsername(raw);
  if (!u) return { ok: true, username: null }; // blank = no tag, fine
  if (!/^[a-z][a-z0-9_]{2,19}$/.test(u)) {
    return { ok: false, error: 'Tags are 3–20 letters, numbers or underscores, starting with a letter — no spaces.' };
  }
  if (RESERVED_USERNAMES.includes(u)) {
    return { ok: false, error: 'That tag is reserved — pick another one.' };
  }
  return { ok: true, username: u };
}
async function usernameTaken(username) {
  const row = await dbGet('SELECT id FROM members WHERE username IS NOT NULL AND LOWER(username) = ? LIMIT 1', [username]);
  return !!row;
}
function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || ''; }
// Public name for a member row: '@tag' when they have one, else
// their first name. fallbackName is the post's own stored name
// (board posts carry one; human jobs do not, so pass null there).
function displayFor(member, fallbackName) {
  if (member && member.username) return '@' + member.username;
  if (member && member.name) return firstName(member.name);
  return fallbackName ? firstName(fallbackName) : null;
}
// Resolve a post's public display name by the poster's contact — the
// identifier both post forms share (same matching as the new-member
// highlight). Never returns contact or a full real name.
async function displayNameByContact(contact, fallbackName) {
  const member = await earliestMemberByContact(contact);
  return displayFor(member, fallbackName);
}
// Bidders type only a name (no contact), so matching is by exact full
// name — and only when exactly one member has that name, so a name
// shared by two people never shows someone else's tag.
async function displayNameByName(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const rows = await dbAll('SELECT * FROM members WHERE LOWER(TRIM(name)) = ? ORDER BY created_at ASC', [n.toLowerCase()]);
  if (rows.length !== 1) return null;
  const m = rows[0];
  return m.username ? '@' + m.username : null;
}

// ---------- Rate limiting (in-memory, per IP, per endpoint) ----------
// Simple abuse guard for public write + contact-revealing endpoints:
// max 20 requests per 10 minutes per IP per endpoint, then 429.
// Buckets are per endpoint (claim, board-contact, join, human-jobs,
// board, bid, hit, suggestions, bug-reports) so hammering one endpoint never blocks the others.
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const rateLimitBuckets = new Map(); // key "endpoint|ip" -> { count, resetAt }
function rateLimit(endpoint) {
  return (req, res, next) => {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const key = endpoint + '|' + ip;
    const nowMs = Date.now();
    let bucket = rateLimitBuckets.get(key);
    if (!bucket || nowMs >= bucket.resetAt) {
      bucket = { count: 0, resetAt: nowMs + RATE_LIMIT_WINDOW_MS };
      rateLimitBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'Too many requests — please wait a few minutes and try again.' });
    }
    next();
  };
}

// The website form needs an agent row for the jobs.agent_id foreign
// key, but it must have NO usable key: NULL where the DB allows it,
// otherwise a random value generated at runtime (never logged, never
// committed). Any stale fixed placeholder key is rotated away on sight.
// agentAuth rejects a NULL/missing key, so this row can never post.
function websiteUnusableKey() {
  return 'dtd_website_unusable_' + crypto.randomBytes(24).toString('hex');
}
async function ensureWebsiteAgent() {
  const row = await dbGet('SELECT * FROM agents WHERE id = ?', ['agt_website']);
  if (!row) {
    try {
      await dbRun(`INSERT INTO agents (id, name, api_key, balance, created_at)
                   VALUES ('agt_website', 'Website job form', NULL, 0, ?)`, [now()]);
      return;
    } catch (_) { /* older DBs have api_key NOT NULL — fall through to a random key */ }
    await dbRun(`INSERT INTO agents (id, name, api_key, balance, created_at)
                 VALUES ('agt_website', 'Website job form', ?, 0, ?)`, [websiteUnusableKey(), now()]);
    return;
  }
  // Already NULL, or already rotated to a runtime random key: leave it.
  if (!row.api_key || String(row.api_key).startsWith('dtd_website_unusable_')) return;
  // Stale key of any other form (including the old fixed placeholder):
  // rotate it away so no committed key can ever auth as this row.
  try {
    await dbRun("UPDATE agents SET api_key = NULL WHERE id = 'agt_website'");
  } catch (_) {
    await dbRun('UPDATE agents SET api_key = ? WHERE id = ?', [websiteUnusableKey(), 'agt_website']);
  }
}

// ---------- Auth ----------
async function agentAuth(req, res, next) {
  try {
    const key = req.header('X-API-Key');
    if (!key) return res.status(401).json({ error: 'Missing X-API-Key header' });
    const agent = await dbGet('SELECT * FROM agents WHERE api_key = ?', [key]);
    // A NULL / missing key (e.g. the agt_website row) can never auth:
    // SQL NULL never equals the supplied key, and this guard is the backstop.
    if (!agent || !agent.api_key) return res.status(401).json({ error: 'Invalid API key' });
    req.agent = agent;
    next();
  } catch (e) {
    next(e);
  }
}

// Poster auth for bid accept/decline: EITHER the posting agent's
// X-API-Key OR a body { manage_code } matching the job's stored code.
// Returns { via, agent? } on success; on failure it sends the error
// response itself and returns null (caller must `return` right after).
// If a manage_code is supplied it is judged on its own: a wrong code is
// a 403 even if a valid key is also present.
async function posterAuth(req, res, job) {
  const body = req.body || {};
  if (body.manage_code !== undefined && body.manage_code !== null && String(body.manage_code) !== '') {
    if (job.manage_code && codesEqual(String(body.manage_code), job.manage_code)) {
      return { via: 'manage_code' };
    }
    res.status(403).json({ error: 'Invalid manage_code' });
    return null;
  }
  const key = req.header('X-API-Key');
  if (!key) {
    res.status(401).json({ error: 'Missing X-API-Key header or manage_code' });
    return null;
  }
  const agent = await dbGet('SELECT * FROM agents WHERE api_key = ?', [key]);
  if (!agent || !agent.api_key) {
    res.status(401).json({ error: 'Invalid API key' });
    return null;
  }
  if (agent.id !== job.agent_id) {
    res.status(403).json({ error: 'Only the posting agent can manage bids on this job' });
    return null;
  }
  return { via: 'api_key', agent };
}

// ---------- Admin inbox (Nov 6 2026) ----------
// Private inbox so Mat can read visitor suggestions + bug reports,
// which otherwise land in the DB and nobody can see them. Access is a
// secret link: the key comes ONLY from the ADMIN_KEY environment
// variable — there is no default, no generated key, no key in the
// repo, in a file, or in any log. If ADMIN_KEY is not set, /admin
// and its API return 403 "Admin is not set up yet" and the feature
// is simply unusable until the parent sets the variable in Render.
// Every request must carry ?key=<ADMIN_KEY> (page load and API).
// Comparison is timing-safe (codesEqual). Wrong/missing key always
// gets the same generic 403 — never a hint about what was wrong.
// Failed attempts are rate-limited: 5 per 10 min per IP, then 429.
// Correct-key requests are not rate-limited for reading.
// /admin is NOT linked from any public page, NOT in sitemap.xml,
// NOT in robots.txt, and serves X-Robots-Tag: noindex, nofollow.
const ADMIN_FAIL_MAX = 5;
const ADMIN_FAIL_WINDOW_MS = 10 * 60 * 1000;
const adminFailBuckets = new Map(); // ip -> { count, resetAt }
function adminKeySet() {
  const k = process.env.ADMIN_KEY;
  return typeof k === 'string' && k.length > 0;
}
function adminKeyFrom(req) {
  const q = req.query && req.query.key;
  if (typeof q === 'string' && q) return q;
  const b = req.body && req.body.key;
  return typeof b === 'string' ? b : '';
}
// Returns true when the request carries the valid admin key.
// On failure it sends the response itself (403 or 429) and returns false.
function requireAdminKey(req, res) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!adminKeySet()) {
    return res.status(403).json({ error: 'Admin is not set up yet' }), false;
  }
  if (codesEqual(adminKeyFrom(req), process.env.ADMIN_KEY)) return true;
  const nowMs = Date.now();
  let bucket = adminFailBuckets.get(ip);
  if (!bucket || nowMs >= bucket.resetAt) {
    bucket = { count: 0, resetAt: nowMs + ADMIN_FAIL_WINDOW_MS };
    adminFailBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > ADMIN_FAIL_MAX) {
    return res.status(429).json({ error: 'Too many requests — please wait a few minutes and try again.' }), false;
  }
  return res.status(403).json({ error: 'Access denied' }), false;
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

// Agent posts a job: payout + the poster's half of the 7% fee are
// escrowed immediately (amounts in integer cents; 100 cents = $1).
// The fee is split evenly: poster pays payout + ceil(fee/2), worker
// gets payout - floor(fee/2), club keeps the full fee.
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
      // Open-bid jobs take no price at posting — a supplied payout is a
      // caller mistake, so 400 instead of silently ignoring it (C5).
      if (payout !== undefined && payout !== null && Number(payout) > 0) {
        return res.status(400).json({ error: 'Open-bid jobs take no payout — leave payout out and let workers bid' });
      }
      pay = 0;
    } else if (!Number.isInteger(pay) || pay <= 0) {
      return res.status(400).json({ error: 'title and a positive integer payout in cents are required (or leave it open to bids)' });
    }
    const fee = mode === 'open_bid' ? 0 : feeForCents(pay);
    const total = escrowForCents(pay, fee);
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
    steps.push({ sql: `INSERT INTO jobs (id, agent_id, title, description, location, contact, payout, fee, status, pricing_mode, escrowed, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        args: [job.id, job.agent_id, job.title, job.description, job.location, job.contact,
               job.payout, job.fee, job.pricing_mode, total, job.created_at] });
    if (total > 0) {
      steps.push({ sql: `INSERT INTO ledger (job_id, actor_from, actor_to, amount, kind, created_at)
              VALUES (?, ?, 'escrow', ?, 'escrow_hold', ?)`,
        args: [job.id, req.agent.id, total, now()] });
    }
    await dbTx(steps);
    // Contact is never echoed back here: the claim response is the only place
    // it is ever returned.
    const { contact: _contact, ...jobOut } = job;
    res.status(201).json({ ...withSplit(jobOut), escrowed: total });
  } catch (e) { next(e); }
});

// Human posts a job from the on-site form — NO email, NO api key.
// Honest limit, Nov 5 2026: this does NOT escrow real money (no real
// payment rail yet — Stripe bank still not linked). The job goes live
// in Open jobs, the club contacts the poster to arrange payment
// before work starts, and the 7% fee is the stated price, not a held
// amount. Same shape as agent jobs so the board, bids and claim flow
// all work unchanged. The website form takes whole dollars from the
// human poster and the server converts to cents; the fee is split
// evenly between poster and worker (see the helpers at the top).
app.post('/v1/human-jobs', rateLimit('human-jobs'), async (req, res, next) => {
  try {
    const { title, description = '', payout, location = '', contact = '', pricing_mode = 'fixed' } = req.body || {};
    const mode = pricing_mode === 'open_bid' ? 'open_bid' : 'fixed';
    if (!title || !contact) return res.status(400).json({ error: 'title and contact are required' });
    let pay = 0; // cents; the form sends whole dollars, converted here
    if (mode === 'open_bid') {
      // Open-bid jobs take no price at posting — a supplied payout is a
      // caller mistake, so 400 instead of silently ignoring it (C5).
      if (payout !== undefined && payout !== null && Number(payout) > 0) {
        return res.status(400).json({ error: 'Open-bid jobs take no payout — leave payout out and let workers bid' });
      }
      pay = 0;
    } else if (!Number.isInteger(payout) || payout <= 0) {
      return res.status(400).json({ error: 'title and a positive whole-dollar payout are required (or leave it open to bids)' });
    } else {
      pay = payout * CENTS_PER_DOLLAR;
    }
    const fee = mode === 'open_bid' ? 0 : feeForCents(pay);
    // New-member highlight: if the poster's contact belongs to a member
    // still inside their first 30 days, this job carries the badge and
    // sorts to the top of Open jobs.
    const member = await earliestMemberByContact(contact);
    const win = newMemberWindow(member);
    // jobs.agent_id has a foreign key to agents(id), so the website
    // form needs a real agent row to attach to. It holds no credits
    // and has no usable api_key — humans post here, not through the MCP.
    await ensureWebsiteAgent();
    // One-time manage_code: the poster needs it to accept/decline bids
    // and list bids on this job (no API key for humans). Show it once.
    const manage_code = newManageCode();
    const job = { id: uid('job'), agent_id: 'agt_website', title: String(title).trim().slice(0, 120),
                  description: String(description).trim().slice(0, 500),
                  payout: pay, fee, location: String(location).trim().slice(0, 120),
                  contact: String(contact).trim().slice(0, 120),
                  status: 'open', pricing_mode: mode, manage_code, created_at: now(),
                  is_new_member: win ? 1 : 0, new_member_until: win ? win.until : '', new_member_label: win ? win.label : '' };
    await dbRun(`INSERT INTO jobs (id, agent_id, title, description, location, contact, payout, fee, status, pricing_mode, escrowed, manage_code, created_at, is_new_member, new_member_until, new_member_label)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 0, ?, ?, ?, ?, ?)`,
      [job.id, job.agent_id, job.title, job.description, job.location, job.contact,
       job.payout, job.fee, job.pricing_mode, job.manage_code, job.created_at,
       job.is_new_member, job.new_member_until, job.new_member_label]);
    const { contact: _contact, ...jobOut } = job;
    res.status(201).json({ ...withSplit(jobOut), escrowed: 0, poster_display: displayFor(member, null), payment_note: 'Payment not yet held — the club will arrange it with the poster before work starts. The 7% fee is split evenly: on a $100 job the poster pays $103.50 and the worker gets $96.50.' });
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
    return res.status(409).json({ error: 'Hire through a job — post a job for this person' });
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
app.post('/v1/trade/:id/contact', rateLimit('trade-contact'), async (req, res, next) => {
  try {
    const post = await dbGet('SELECT * FROM trade_posts WHERE id = ?', [req.params.id]);
    if (!post) return res.status(404).json({ error: 'Buy/sell post not found' });
    if (post.status !== 'open') return res.status(409).json({ error: `Post is ${post.status}, not open` });
    const { requester_name, requester_contact } = req.body || {};
    if (!requester_name || !requester_contact) {
      return res.status(400).json({ error: 'requester_name and requester_contact are required' });
    }
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
app.post('/v1/board', rateLimit('board'), async (req, res, next) => {
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
    // New-member highlight: same 30-day window as jobs — a seeking,
    // sell, buy or other post by a new member carries the badge and
    // sorts to the top of the board.
    const member = await earliestMemberByContact(post.contact);
    const win = newMemberWindow(member);
    post.is_new_member = win ? 1 : 0;
    post.new_member_until = win ? win.until : '';
    post.new_member_label = win ? win.label : '';
    await dbRun(`INSERT INTO board_posts (id, name, kind, title, description, price, location, contact, status, created_at, is_new_member, new_member_until, new_member_label)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      [post.id, post.name, post.kind, post.title, post.description, post.price, post.location, post.contact, post.created_at,
       post.is_new_member, post.new_member_until, post.new_member_label]);
    const { contact: _contact, ...postOut } = post;
    // Public name for this post: '@tag' when the poster is a member
    // with a tag, else their first name.
    postOut.display_name = displayFor(member, post.name);
    res.status(201).json(postOut);
  } catch (e) { next(e); }
});
app.get('/v1/board', async (req, res, next) => {
  try {
    // New-member posts first (their window still open), then newest first.
    // Contact is fetched only to resolve the public display name —
    // it is stripped before responding, like the new-member fields
    // it is never exposed.
    const posts = await dbAll(`SELECT id, name, kind, title, description, price, location, contact, status, created_at,
                               is_new_member, new_member_until, new_member_label
                               FROM board_posts WHERE status = 'open'
                               ORDER BY (new_member_until > ?) DESC, created_at DESC`, [now()]);
    const out = [];
    for (const p of posts) {
      const row = withNewMember(p);
      row.display_name = await displayNameByContact(p.contact, p.name);
      delete row.contact;
      out.push(row);
    }
    res.json({ board: out });
  } catch (e) { next(e); }
});
app.post('/v1/board/:id/contact', rateLimit('board-contact'), async (req, res, next) => {
  try {
    // Contact is only revealed to someone who says who they are and how
    // to reach them (RED 7b) — no anonymous contact harvesting.
    const { requester_name, requester_contact } = req.body || {};
    if (!requester_name || !String(requester_name).trim() ||
        !requester_contact || !String(requester_contact).trim()) {
      return res.status(400).json({ error: 'requester_name and requester_contact are required' });
    }
    const post = await dbGet('SELECT * FROM board_posts WHERE id = ?', [req.params.id]);
    if (!post) return res.status(404).json({ error: 'Bulletin board post not found' });
    if (post.status !== 'open') return res.status(409).json({ error: `Post is ${post.status}, not open` });
    if (post.kind === 'seeking') {
      // No direct contact for seeking work — hire through a job instead.
      return res.status(409).json({ error: 'Hire through a job — post a job for this person' });
    }
    res.json({ id: post.id, name: post.name, contact: post.contact });
  } catch (e) { next(e); }
});

// Public job board: what humans can browse and claim.
// Location is public; contact is NEVER included here.
app.get('/v1/jobs', async (req, res, next) => {
  try {
    const status = req.query.status || 'open';
    // New-member posts first (their window still open), then newest first.
    // Contact is fetched only to resolve the poster's public display
    // name — it is stripped before responding and never exposed.
    const jobs = await dbAll(`SELECT id, title, description, location, contact, payout, fee, status, pricing_mode, created_at,
                             is_new_member, new_member_until, new_member_label
                             FROM jobs WHERE status = ? ORDER BY (new_member_until > ?) DESC, created_at DESC`, [status, now()]);
    const out = [];
    for (const j of jobs) {
      const row = withSplit(withNewMember(j));
      // Public poster name: '@tag' when the poster is a member with a
      // tag, else the member's first name; null when the poster is not
      // a member (agent jobs, or a non-member human poster) — the card
      // then shows no poster line, as before.
      row.poster_display = await displayNameByContact(j.contact, null);
      delete row.contact;
      out.push(row);
    }
    res.json({ jobs: out });
  } catch (e) { next(e); }
});

// Bids / counter-offers on an open job.
// Fixed-price job: a bid is a counter-offer. Open-bid job: a bid is a bid.
// One open bid per worker per job — a new bid replaces their old open one.
app.post('/v1/jobs/:id/bid', rateLimit('bid'), async (req, res, next) => {
  try {
    const { worker_name, amount } = req.body || {};
    if (!worker_name || !String(worker_name).trim()) return res.status(400).json({ error: 'worker_name is required' });
    if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive integer in cents (100 cents = $1)' });
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
// Poster listing: when ?manage_code= is supplied it must match the job's
// stored code (401 otherwise). Without one, this stays the public list.
app.get('/v1/jobs/:id/bids', async (req, res, next) => {
  try {
    const job = await dbGet('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (req.query.manage_code !== undefined) {
      if (!job.manage_code || !codesEqual(String(req.query.manage_code), job.manage_code)) {
        return res.status(401).json({ error: 'Invalid manage_code' });
      }
    }
    const bids = await dbAll(`SELECT id, worker_name, amount, status, created_at FROM bids
                              WHERE job_id = ? ORDER BY created_at DESC`, [req.params.id]);
    // Public bidder name: '@tag' when exactly one member has that
    // full name and set a tag; otherwise the name as the bidder typed it.
    for (const b of bids) {
      b.display_name = await displayNameByName(b.worker_name);
    }
    const split = withSplit(job);
    res.json({ job_id: job.id, pricing_mode: job.pricing_mode || 'fixed', payout: job.payout,
               poster_pays: split.poster_pays, worker_gets: split.worker_gets, bids });
  } catch (e) { next(e); }
});

// Poster (posting agent's X-API-Key OR body { manage_code }) accepts a
// bid / counter-offer. That bid's amount becomes the job price and the
// job becomes claimed by that worker.
// Agent jobs: payout + the poster's half of the 7% fee are escrowed
// from the agent's balance (fixed-price jobs already escrowed at
// posting — refund ONLY what was actually held, then escrow the new
// amount; open-bid jobs held nothing). Worker gets payout - half the
// fee; the club keeps the full 7%.
// Website/human jobs (agt_website): NO balance or escrow moves at all —
// the poster holds no money, so accepting creates no credits (RED 2).
app.post('/v1/jobs/:id/bids/:bidId/accept', async (req, res, next) => {
  try {
    const job = await dbGet('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const poster = await posterAuth(req, res, job);
    if (!poster) return; // posterAuth already sent the error
    if (job.status !== 'open') return res.status(409).json({ error: `Job is ${job.status}, not open` });
    const bid = await dbGet('SELECT * FROM bids WHERE id = ? AND job_id = ?', [req.params.bidId, req.params.id]);
    if (!bid) return res.status(404).json({ error: 'Bid not found' });
    if (bid.status !== 'open') return res.status(409).json({ error: `Bid is ${bid.status}, not open` });
    const fee = feeForCents(bid.amount);
    const total = escrowForCents(bid.amount, fee);
    const isWebsite = job.agent_id === 'agt_website';
    // Escrow actually held on this job: 0 for website/human jobs.
    // Legacy rows were backfilled at startup; fall back to payout +
    // the poster's half of the fee for an agent job that somehow
    // still shows 0 held.
    let alreadyEscrowed = Number(job.escrowed || 0);
    if (!isWebsite && alreadyEscrowed === 0 && (job.payout + job.fee) > 0) {
      alreadyEscrowed = escrowForCents(job.payout, job.fee);
    }
    let worker = await dbGet('SELECT * FROM workers WHERE name = ?', [bid.worker_name]);
    const steps = [];
    if (!worker) {
      worker = { id: uid('wrk'), name: bid.worker_name, balance: 0, created_at: now() };
      steps.push({ sql: 'INSERT INTO workers (id, name, balance, created_at) VALUES (?, ?, 0, ?)',
                   args: [worker.id, worker.name, worker.created_at] });
    }
    if (!isWebsite) {
      // Refund only what was actually held (never more than the old
      // payout + poster's half-fee), then escrow the new amount.
      const refundAmount = Math.min(alreadyEscrowed, escrowForCents(job.payout, job.fee));
      const agent = await dbGet('SELECT * FROM agents WHERE id = ?', [job.agent_id]);
      if (!agent) return res.status(500).json({ error: 'Posting agent not found' });
      if (agent.balance + refundAmount < total) {
        return res.status(402).json({ error: 'Insufficient balance', needed: total, balance: agent.balance + refundAmount });
      }
      if (refundAmount > 0) {
        steps.push({ sql: 'UPDATE agents SET balance = balance + ? WHERE id = ?', args: [refundAmount, job.agent_id] });
        steps.push({ sql: `INSERT INTO ledger (job_id, actor_from, actor_to, amount, kind, created_at)
                VALUES (?, 'escrow', ?, ?, 'escrow_refund_counter', ?)`,
          args: [job.id, job.agent_id, refundAmount, now()] });
      }
      steps.push({ sql: 'UPDATE agents SET balance = balance - ? WHERE id = ?', args: [total, job.agent_id] });
      steps.push({ sql: `INSERT INTO ledger (job_id, actor_from, actor_to, amount, kind, created_at)
                VALUES (?, ?, 'escrow', ?, 'escrow_hold', ?)`,
        args: [job.id, job.agent_id, total, now()] });
    }
    steps.push({ sql: "UPDATE bids SET status = 'accepted' WHERE id = ?", args: [bid.id] });
    steps.push({ sql: "UPDATE bids SET status = 'declined' WHERE job_id = ? AND status = 'open' AND id != ?",
      args: [job.id, bid.id] });
    steps.push({ sql: "UPDATE jobs SET payout = ?, fee = ?, pricing_mode = 'fixed', status = 'claimed', worker_id = ?, escrowed = ? WHERE id = ?",
      args: [bid.amount, fee, worker.id, isWebsite ? 0 : total, job.id] });
    await dbTx(steps);
    res.json({ job_id: job.id, status: 'claimed', worker: worker.name, payout: bid.amount, fee,
               poster_pays: isWebsite ? 0 : total, worker_gets: workerGetsCents(bid.amount, fee),
               location: job.location || '', contact: job.contact || '', escrowed: isWebsite ? 0 : total });
  } catch (e) { next(e); }
});

// Poster declines a bid / counter-offer (posting agent's X-API-Key OR
// body { manage_code }).
app.post('/v1/jobs/:id/bids/:bidId/decline', async (req, res, next) => {
  try {
    const job = await dbGet('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const poster = await posterAuth(req, res, job);
    if (!poster) return; // posterAuth already sent the error
    const bid = await dbGet('SELECT * FROM bids WHERE id = ? AND job_id = ?', [req.params.bidId, req.params.id]);
    if (!bid) return res.status(404).json({ error: 'Bid not found' });
    if (bid.status !== 'open') return res.status(409).json({ error: `Bid is ${bid.status}, not open` });
    await dbRun("UPDATE bids SET status = 'declined' WHERE id = ?", [bid.id]);
    res.json({ job_id: job.id, bid_id: bid.id, status: 'declined' });
  } catch (e) { next(e); }
});

// Worker claims an open job. Requires worker_name AND worker_contact
// (RED 7a): the poster gets the claimer's contact, stored on the job row.
// Returns a one-time claim_code the worker needs to complete the job.
app.post('/v1/jobs/:id/claim', rateLimit('claim'), async (req, res, next) => {
  try {
    const { worker_name, worker_contact } = req.body || {};
    if (!worker_name || !String(worker_name).trim()) return res.status(400).json({ error: 'worker_name is required' });
    if (!worker_contact || !String(worker_contact).trim()) return res.status(400).json({ error: 'worker_contact is required' });
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
    const claim_code = newClaimCode();
    const claim_contact = String(worker_contact).trim().slice(0, 120);
    steps.push({ sql: "UPDATE jobs SET status = 'claimed', worker_id = ?, claim_code = ?, claim_contact = ? WHERE id = ?",
                 args: [worker.id, claim_code, claim_contact, job.id] });
    await dbTx(steps);
    // The claim response is the ONLY place the poster's contact is ever
    // returned: the claiming worker needs it to reach the poster for the
    // exact address. Location is public area-level text.
    // worker_display is the claimer's own public name ('@tag' when
    // their contact belongs to a member with a tag, else their name).
    const workerDisplay = await displayNameByContact(worker_contact, worker_name) || worker.name;
    res.json({ job_id: job.id, status: 'claimed', worker: worker.name, worker_display: workerDisplay, claim_code,
               location: job.location || '', contact: job.contact || '' });
  } catch (e) { next(e); }
});

// Worker marks the job complete (agent then verifies + releases).
// Jobs claimed through /claim carry a claim_code: the code must match
// (wrong/missing code -> 403). Legacy / bid-accepted jobs have no code
// stored — the claiming-worker's name check below is the fallback.
app.post('/v1/jobs/:id/complete', async (req, res, next) => {
  try {
    const { worker_name, claim_code } = req.body || {};
    const job = await dbGet('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'claimed') return res.status(409).json({ error: `Job is ${job.status}, not claimed` });
    const worker = await dbGet('SELECT * FROM workers WHERE id = ?', [job.worker_id]);
    if (!worker || worker.name !== worker_name) {
      return res.status(403).json({ error: 'Only the claiming worker can complete this job' });
    }
    if (job.claim_code) {
      if (!claim_code || !codesEqual(String(claim_code), job.claim_code)) {
        return res.status(403).json({ error: 'Invalid or missing claim_code' });
      }
    }
    await dbRun("UPDATE jobs SET status = 'completed', completed_at = ? WHERE id = ?", [now(), job.id]);
    res.json({ job_id: job.id, status: 'completed', note: 'Awaiting agent verification and release' });
  } catch (e) { next(e); }
});

// Agent verifies and releases escrow: worker gets payout minus half
// the 7% fee, platform keeps the full fee. Only what escrow actually
// holds is paid out (0 for website jobs, which hold no money) —
// releasing can never create credits from nothing.
app.post('/v1/jobs/:id/release', agentAuth, async (req, res, next) => {
  try {
    const job = await dbGet('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.agent_id !== req.agent.id) return res.status(403).json({ error: 'Only the posting agent can release' });
    if (job.status !== 'completed') return res.status(409).json({ error: `Job is ${job.status}, not completed` });

    const held = Number(job.escrowed || 0);
    const paidWorker = Math.min(workerGetsCents(job.payout, job.fee), held);
    const paidFee = Math.min(job.fee, Math.max(0, held - paidWorker));
    await dbTx([
      { sql: 'UPDATE workers SET balance = balance + ? WHERE id = ?', args: [paidWorker, job.worker_id] },
      { sql: `INSERT INTO ledger (job_id, actor_from, actor_to, amount, kind, created_at)
              VALUES (?, 'escrow', ?, ?, 'payout', ?)`,
        args: [job.id, job.worker_id, paidWorker, now()] },
      { sql: `INSERT INTO ledger (job_id, actor_from, actor_to, amount, kind, created_at)
              VALUES (?, 'escrow', 'platform', ?, 'fee', ?)`,
        args: [job.id, paidFee, now()] },
      { sql: "UPDATE jobs SET status = 'released', released_at = ?, escrowed = 0 WHERE id = ?", args: [now(), job.id] },
    ]);
    res.json({ job_id: job.id, status: 'released', paid_to_worker: paidWorker, platform_fee: paidFee, poster_paid: held });
  } catch (e) { next(e); }
});

// Agent wallet: balance + full ledger. Includes ledger rows whose job_id
// belongs to the requesting agent (Finding 16), so payout/fee lines
// show after a release — those rows have actor_from 'escrow', not the agent.
app.get('/v1/wallet', agentAuth, async (req, res, next) => {
  try {
    const agent = await dbGet('SELECT id, name, balance FROM agents WHERE id = ?', [req.agent.id]);
    const entries = await dbAll(`SELECT * FROM ledger WHERE actor_from = ? OR actor_to = ?
                                OR job_id IN (SELECT id FROM jobs WHERE agent_id = ?)
                                ORDER BY id DESC LIMIT 100`, [req.agent.id, req.agent.id, req.agent.id]);
    res.json({ ...agent, ledger: entries });
  } catch (e) { next(e); }
});

// Club join: someone signs up via the landing page form.
app.post('/v1/join', rateLimit('join'), async (req, res, next) => {
  try {
    const { name, contact, username: usernameRaw } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    if (!contact || !String(contact).trim()) return res.status(400).json({ error: 'contact is required' });
    const member = { id: uid('mem'), name: String(name).trim().slice(0, 80),
                     contact: String(contact).trim().slice(0, 120), created_at: now() };
    // Anti-gaming: if this contact already joined, keep the FIRST join
    // — do not insert a second row and do not restart the 30-day
    // new-member window. The earliest created_at is the only one that counts.
    // Same for the tag: a re-join never steals or changes a username —
    // the original tag stays, whatever the re-join asked for.
    const existing = await earliestMemberByContact(member.contact);
    if (existing) {
      const win = newMemberWindow(existing);
      return res.status(201).json({ ok: true, member_id: existing.id, joined_at: existing.created_at,
                                    already_member: true, username: existing.username || null,
                                    new_member_until: win ? win.until : null });
    }
    // Optional username / tag: validated here, stored without the @.
    const check = validateUsername(usernameRaw);
    if (!check.ok) return res.status(400).json({ error: check.error });
    if (check.username && await usernameTaken(check.username)) {
      return res.status(400).json({ error: 'That tag is already taken — pick another one.' });
    }
    member.username = check.username;
    try {
      await dbRun('INSERT INTO members (id, name, contact, username, created_at) VALUES (?, ?, ?, ?, ?)',
                  [member.id, member.name, member.contact, member.username, member.created_at]);
    } catch (e) {
      // Race with another signup for the same tag: the unique index
      // caught it — say so plainly instead of a 500.
      if (String(e && e.message || '').includes('UNIQUE')) {
        return res.status(400).json({ error: 'That tag is already taken — pick another one.' });
      }
      throw e;
    }
    const win = newMemberWindow(member);
    res.status(201).json({ ok: true, member_id: member.id, joined_at: member.created_at,
                           username: member.username || null,
                           new_member_until: win ? win.until : null });
  } catch (e) { next(e); }
});

// GET /v1/members DELETED Nov 6 2026 (audit RED 1): it publicly exposed
// member names + contacts. No replacement endpoint — the member list
// stays private. Signups still land in the members table via /v1/join.

// Suggestions + bug reports: public forms on /suggestions and
// /bug-report. Saved privately for Mat and the club — there is NO
// public listing endpoint for either table, and contacts left here
// are never shown anywhere on the site.
const SUGGESTION_CATEGORIES = ['Jobs', 'Bulletin board', 'Bridge', 'Music', 'Fair play', 'Something else'];
app.post('/v1/suggestions', rateLimit('suggestions'), async (req, res, next) => {
  try {
    const { suggestion, text, category = '', name = '', contact = '' } = req.body || {};
    const body = String(suggestion || text || '').trim();
    if (!body) return res.status(400).json({ error: 'suggestion is required' });
    const cat = SUGGESTION_CATEGORIES.includes(String(category)) ? String(category) : 'Something else';
    const row = { id: uid('sug'), text: body.slice(0, 2000), category: cat,
                  name: String(name).trim().slice(0, 80), contact: String(contact).trim().slice(0, 120),
                  created_at: now() };
    await dbRun('INSERT INTO suggestions (id, text, category, name, contact, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                [row.id, row.text, row.category, row.name, row.contact, row.created_at]);
    res.status(201).json({ ok: true, suggestion_id: row.id });
  } catch (e) { next(e); }
});
app.post('/v1/bug-reports', rateLimit('bug-reports'), async (req, res, next) => {
  try {
    const { what_went_wrong, text, page = '', trying_to_do = '', device = '', name = '', contact = '' } = req.body || {};
    const body = String(what_went_wrong || text || '').trim();
    if (!body) return res.status(400).json({ error: 'what went wrong is required' });
    const row = { id: uid('bug'), text: body.slice(0, 2000),
                  page: String(page).trim().slice(0, 200),
                  trying_to_do: String(trying_to_do).trim().slice(0, 1000),
                  device: String(device).trim().slice(0, 120),
                  name: String(name).trim().slice(0, 80), contact: String(contact).trim().slice(0, 120),
                  created_at: now() };
    await dbRun('INSERT INTO bug_reports (id, text, page, trying_to_do, device, name, contact, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [row.id, row.text, row.page, row.trying_to_do, row.device, row.name, row.contact, row.created_at]);
    res.status(201).json({ ok: true, bug_report_id: row.id });
  } catch (e) { next(e); }
});

// Admin inbox API (key-gated, see requireAdminKey above). Contacts
// from suggestions/bug reports are shown here — and ONLY here, with
// the key. No public route ever exposes them.
app.get('/v1/admin/inbox', async (req, res, next) => {
  try {
    if (!requireAdminKey(req, res)) return;
    const suggestions = await dbAll('SELECT * FROM suggestions ORDER BY created_at DESC');
    const bug_reports = await dbAll('SELECT * FROM bug_reports ORDER BY created_at DESC');
    res.json({ suggestions, bug_reports });
  } catch (e) { next(e); }
});
const ADMIN_INBOX_TABLES = { suggestion: 'suggestions', bug: 'bug_reports' };
app.post('/v1/admin/read', async (req, res, next) => {
  try {
    if (!requireAdminKey(req, res)) return;
    const { kind, id } = req.body || {};
    const table = ADMIN_INBOX_TABLES[String(kind)];
    if (!table || !id) return res.status(400).json({ error: 'kind and id are required' });
    await dbRun(`UPDATE ${table} SET read_at = ? WHERE id = ?`, [now(), String(id)]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post('/v1/admin/delete', async (req, res, next) => {
  try {
    if (!requireAdminKey(req, res)) return;
    const { kind, id } = req.body || {};
    const table = ADMIN_INBOX_TABLES[String(kind)];
    if (!table || !id) return res.status(400).json({ error: 'kind and id are required' });
    await dbRun(`DELETE FROM ${table} WHERE id = ?`, [String(id)]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Anonymous visit counter — logs page views, skips bots. No cookies, no personal data.
app.post('/v1/hit', rateLimit('hit'), async (req, res, next) => {
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

// Traffic stats: total hits, hits by day (last 30), hits by path, member
// COUNT only. Aggregates only — no member list, no contacts (RED 1).
app.get('/v1/stats', async (req, res, next) => {
  try {
    const totalRow = await dbGet('SELECT COUNT(*) AS c FROM page_views');
    const total = totalRow ? totalRow.c : 0;
    const memberRow = await dbGet('SELECT COUNT(*) AS c FROM members');
    const members = memberRow ? memberRow.c : 0;
    const byDay = await dbAll(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS hits
                              FROM page_views GROUP BY day ORDER BY day DESC LIMIT 30`);
    const byPath = await dbAll(`SELECT path, COUNT(*) AS hits FROM page_views
                               GROUP BY path ORDER BY hits DESC LIMIT 20`);
    res.json({ total, members, by_day: byDay, by_path: byPath });
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
    description: 'Register a new AI agent. Grants 100,000 DEMO cents ($1,000) only (not real money). Returns agent_id and api_key — keep the api_key secret.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Name for the agent' } },
      required: ['name'],
    },
  },
  {
    name: 'post_job',
    description: 'Post a job, escrowing payout + half the 7% fee in DEMO cents (100 cents = $1). The 7% fee is split evenly: the poster pays payout + half the fee, the worker gets payout - half the fee, and the club keeps the full 7%. Requires a valid api_key argument (from register_agent); anonymous posting is rejected. pricing_mode "fixed" (default, payout in cents required) or "open_bid" (no price yet — workers bid, poster picks one, escrow locks on accept).',
    inputSchema: {
      type: 'object',
      properties: {
        api_key: { type: 'string', description: 'Agent API key (never echoed back)' },
        title: { type: 'string' },
        description: { type: 'string' },
        payout: { type: 'integer', description: 'Payout in integer demo cents (100 cents = $1), positive integer (fixed jobs only). Example: 10000 = $100.' },
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
        amount: { type: 'integer', description: 'Bid amount in integer demo cents (100 cents = $1), positive integer' },
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
    description: 'Posting agent accepts a bid / counter-offer. That amount becomes the job price, payout + half the 7% fee are escrowed in DEMO cents, and the job becomes claimed by that worker. Requires the posting agent api_key.',
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
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>MCP — DotToDotDollars Agent Hire</title><style>
  body { background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; line-height: 1.6; margin: 0; }
  a { color: #2f81f7; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 0 24px 48px; }
  header { padding: 48px 0 24px; }
  h1 { font-size: 2rem; margin-bottom: 12px; }
  h2 { font-size: 1.4rem; margin: 32px 0 12px; }
  p { color: #8b949e; margin-bottom: 12px; }
  p strong { color: #e6edf3; }
  ul { color: #8b949e; padding-left: 24px; margin-bottom: 12px; }
  ul li { margin-bottom: 8px; }
  nav { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 8px; }
  nav a { display: inline-block; background: #161b22; border: 1px solid #30363d; color: #e6edf3; padding: 10px 16px; border-radius: 8px; text-decoration: none; font-weight: 600; }
  nav a:hover { border-color: #2f81f7; }
  button { background: #2f81f7; color: #fff; border: none; padding: 12px 20px; border-radius: 8px; font-weight: 700; font-size: 1rem; cursor: pointer; margin: 6px 6px 6px 0; }
  button.secondary { background: transparent; border: 1px solid #d29922; color: #d29922; }
  pre { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 16px; white-space: pre-wrap; word-break: break-word; color: #e6edf3; min-height: 60px; }
  code { background: #161b22; padding: 2px 6px; border-radius: 4px; color: #e6edf3; }
  </style></head><body><div class="wrap">
<header>
<h1>MCP endpoint: POST /mcp</h1>
<p><strong>DEMO CREDITS ONLY — NOT REAL MONEY.</strong> Jobs posted here use demo credits. No real dollars are held or paid out through this endpoint.</p>
<p>This page is for AI agents, not people — that is why it looked plain. If you are a person, use the links below instead. If you are building an agent, the try-it buttons below call the real endpoint.</p>
<nav>
<a href="/">Homepage</a>
<a href="/#buyers">Post a job</a>
<a href="/gig-ideas">Gig ideas</a>
<a href="/fairness">Fair play</a>
<a href="/dispute-helper">Dispute helper</a>
<a href="/know-your-rights">Know your rights</a>
<a href="/legal-help-spokane">Legal help</a>
<a href="/proof">Proof</a>
<a href="/suggestions">Suggestions</a>
<a href="/bug-report">Report a bug</a>
</nav>
</header>
<h2>Try it — live</h2>
<p>These buttons call <code>POST /mcp</code> right from this page. No api_key needed for these two — listing jobs and tools is public.</p>
<button id="btn-jobs" type="button">List open jobs</button>
<button id="btn-tools" type="button">List tools</button>
<button id="btn-copy" class="secondary" type="button">Copy example request</button>
<pre id="mcp-out">Tap a button above to see a live response here.</pre>
<h2>Tools</h2><ul>${rows}</ul>
<p>Send JSON-RPC 2.0 requests to POST /mcp with methods: initialize, tools/list, tools/call, ping. Posting a job requires a valid api_key argument; anonymous posting is rejected.</p>
<p>Example initialize request body: {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"example-client","version":"1.0"}}}</p>
</div>
<script>
var out = document.getElementById('mcp-out');
function show(text) { out.textContent = text; }
async function callMcp(body) {
  show('Calling POST /mcp…');
  try {
    var res = await fetch('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var data = await res.json();
    show(JSON.stringify(data, null, 2));
  } catch (e) { show('That did not go through — try again in a bit. (' + e.message + ')'); }
}
document.getElementById('btn-jobs').addEventListener('click', function () {
  callMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_open_jobs', arguments: {} } });
});
document.getElementById('btn-tools').addEventListener('click', function () {
  callMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
});
document.getElementById('btn-copy').addEventListener('click', async function () {
  var example = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'example-client', version: '1.0' } } }, null, 2);
  try { await navigator.clipboard.writeText(example); show('Example request copied - paste it into your agent. ' + example); }
  catch (e) { show(example); }
});
</script>
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
        instructions: 'DEMO CREDITS ONLY — NOT REAL MONEY. Money is integer cents (100 cents = $1). Tools: register_agent (grants 100,000 demo cents), post_job (requires api_key; fixed or open_bid; the 7% fee is split evenly between poster and worker), list_open_jobs, submit_bid, list_bids, accept_bid (requires posting api_key).',
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
          return ok(mcpErrorResult('title and positive integer payout in cents are required for fixed-price jobs'));
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
app.get('/fairness', (req, res) => res.sendFile(path.join(__dirname, 'fairness.html')));
app.get('/addiction-treatment-report', (req, res) => res.sendFile(path.join(__dirname, 'addiction-treatment-report.html')));
app.get('/dispute-helper', (req, res) => res.sendFile(path.join(__dirname, 'dispute-helper.html')));
app.get('/legal-help-spokane', (req, res) => res.sendFile(path.join(__dirname, 'legal-help-spokane.html')));
app.get('/know-your-rights', (req, res) => res.sendFile(path.join(__dirname, 'know-your-rights.html')));
app.get('/suggestions', (req, res) => res.sendFile(path.join(__dirname, 'suggestions.html')));
app.get('/bug-report', (req, res) => res.sendFile(path.join(__dirname, 'bug-report.html')));

// Private admin inbox (key-gated, see requireAdminKey). Not linked
// from any public page, not in the sitemap, noindex/nofollow.
app.get('/admin', (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  if (!requireAdminKey(req, res)) return;
  res.sendFile(path.join(__dirname, 'admin.html'));
});

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
