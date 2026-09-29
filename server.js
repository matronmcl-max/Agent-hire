// DotToDotDollars — Agent Hire API (prototype)
// The rails for AI agents to hire humans: post a job, fund escrow,
// verify completion, release payment. Platform takes a fee per job.

const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());

const PLATFORM_FEE_RATE = 0.07; // 7% per completed job
const DEMO_GRANT = 1000;        // demo credits granted on agent registration

// ---------- Database ----------
const db = new Database(path.join(__dirname, 'data.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    payout INTEGER NOT NULL,
    fee INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    worker_id TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    released_at TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents(id),
    FOREIGN KEY (worker_id) REFERENCES workers(id)
  );
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    actor_from TEXT,
    actor_to TEXT,
    amount INTEGER NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    contact TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const now = () => new Date().toISOString();
const uid = (p) => p + '_' + crypto.randomBytes(8).toString('hex');

// ---------- Auth ----------
function agentAuth(req, res, next) {
  const key = req.header('X-API-Key');
  if (!key) return res.status(401).json({ error: 'Missing X-API-Key header' });
  const agent = db.prepare('SELECT * FROM agents WHERE api_key = ?').get(key);
  if (!agent) return res.status(401).json({ error: 'Invalid API key' });
  req.agent = agent;
  next();
}

// ---------- Routes ----------

// Register an agent (demo: grants demo credits). In production this
// would sit behind signup + real payment.
app.post('/v1/agents/register', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const agent = {
    id: uid('agt'),
    name,
    api_key: 'dtd_' + crypto.randomBytes(24).toString('hex'),
    balance: DEMO_GRANT,
    created_at: now(),
  };
  db.prepare('INSERT INTO agents (id, name, api_key, balance, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(agent.id, agent.name, agent.api_key, agent.balance, agent.created_at);
  db.prepare(`INSERT INTO ledger (job_id, actor_from, actor_to, amount, kind, created_at)
              VALUES (NULL, 'platform', ?, ?, 'demo_grant', ?)`)
    .run(agent.id, DEMO_GRANT, now());
  res.status(201).json({ agent_id: agent.id, api_key: agent.api_key, balance: agent.balance });
});

// Agent posts a job: payout + platform fee are escrowed immediately.
app.post('/v1/jobs', agentAuth, (req, res) => {
  const { title, description = '', payout } = req.body || {};
  if (!title || !Number.isInteger(payout) || payout <= 0) {
    return res.status(400).json({ error: 'title and positive integer payout are required' });
  }
  const fee = Math.max(1, Math.round(payout * PLATFORM_FEE_RATE));
  const total = payout + fee;
  if (req.agent.balance < total) {
    return res.status(402).json({ error: 'Insufficient balance', needed: total, balance: req.agent.balance });
  }
  const job = { id: uid('job'), agent_id: req.agent.id, title, description, payout, fee,
                status: 'open', created_at: now() };
  const tx = db.transaction(() => {
    db.prepare('UPDATE agents SET balance = balance - ? WHERE id = ?').run(total, req.agent.id);
    db.prepare(`INSERT INTO jobs (id, agent_id, title, description, payout, fee, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`)
      .run(job.id, job.agent_id, job.title, job.description, job.payout, job.fee, job.created_at);
    db.prepare(`INSERT INTO ledger (job_id, actor_from, actor_to, amount, kind, created_at)
                VALUES (?, ?, 'escrow', ?, 'escrow_hold', ?)`)
      .run(job.id, req.agent.id, total, now());
  });
  tx();
  res.status(201).json({ ...job, escrowed: total });
});

// Public job board: what humans can browse and claim.
app.get('/v1/jobs', (req, res) => {
  const status = req.query.status || 'open';
  const jobs = db.prepare(`SELECT id, title, description, payout, status, created_at
                           FROM jobs WHERE status = ? ORDER BY created_at DESC`).all(status);
  res.json({ jobs });
});

// Worker claims an open job.
app.post('/v1/jobs/:id/claim', (req, res) => {
  const { worker_name } = req.body || {};
  if (!worker_name) return res.status(400).json({ error: 'worker_name is required' });
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'open') return res.status(409).json({ error: `Job is ${job.status}, not open` });

  let worker = db.prepare('SELECT * FROM workers WHERE name = ?').get(worker_name);
  const tx = db.transaction(() => {
    if (!worker) {
      worker = { id: uid('wrk'), name: worker_name, balance: 0, created_at: now() };
      db.prepare('INSERT INTO workers (id, name, balance, created_at) VALUES (?, ?, 0, ?)')
        .run(worker.id, worker.name, worker.created_at);
    }
    db.prepare("UPDATE jobs SET status = 'claimed', worker_id = ? WHERE id = ?").run(worker.id, job.id);
  });
  tx();
  res.json({ job_id: job.id, status: 'claimed', worker: worker.name });
});

// Worker marks the job complete (agent then verifies + releases).
app.post('/v1/jobs/:id/complete', (req, res) => {
  const { worker_name } = req.body || {};
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'claimed') return res.status(409).json({ error: `Job is ${job.status}, not claimed` });
  const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(job.worker_id);
  if (!worker || worker.name !== worker_name) {
    return res.status(403).json({ error: 'Only the claiming worker can complete this job' });
  }
  db.prepare("UPDATE jobs SET status = 'completed', completed_at = ? WHERE id = ?").run(now(), job.id);
  res.json({ job_id: job.id, status: 'completed', note: 'Awaiting agent verification and release' });
});

// Agent verifies and releases escrow: worker gets payout, platform keeps fee.
app.post('/v1/jobs/:id/release', agentAuth, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.agent_id !== req.agent.id) return res.status(403).json({ error: 'Only the posting agent can release' });
  if (job.status !== 'completed') return res.status(409).json({ error: `Job is ${job.status}, not completed` });

  const tx = db.transaction(() => {
    db.prepare('UPDATE workers SET balance = balance + ? WHERE id = ?').run(job.payout, job.worker_id);
    db.prepare(`INSERT INTO ledger (job_id, actor_from, actor_to, amount, kind, created_at)
                VALUES (?, 'escrow', ?, ?, 'payout', ?)`)
      .run(job.id, job.worker_id, job.payout, now());
    db.prepare(`INSERT INTO ledger (job_id, actor_from, actor_to, amount, kind, created_at)
                VALUES (?, 'escrow', 'platform', ?, 'fee', ?)`)
      .run(job.id, job.fee, now());
    db.prepare("UPDATE jobs SET status = 'released', released_at = ? WHERE id = ?").run(now(), job.id);
  });
  tx();
  res.json({ job_id: job.id, status: 'released', paid_to_worker: job.payout, platform_fee: job.fee });
});

// Agent wallet: balance + full ledger.
app.get('/v1/wallet', agentAuth, (req, res) => {
  const agent = db.prepare('SELECT id, name, balance FROM agents WHERE id = ?').get(req.agent.id);
  const entries = db.prepare(`SELECT * FROM ledger WHERE actor_from = ? OR actor_to = ?
                              ORDER BY id DESC LIMIT 100`).all(req.agent.id, req.agent.id);
  res.json({ ...agent, ledger: entries });
});

// Club join: someone signs up via the landing page form.
app.post('/v1/join', (req, res) => {
  const { name, contact } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  if (!contact || !String(contact).trim()) return res.status(400).json({ error: 'contact is required' });
  const member = { id: uid('mem'), name: String(name).trim().slice(0, 80),
                   contact: String(contact).trim().slice(0, 120), created_at: now() };
  db.prepare('INSERT INTO members (id, name, contact, created_at) VALUES (?, ?, ?, ?)')
    .run(member.id, member.name, member.contact, member.created_at);
  res.status(201).json({ ok: true, member_id: member.id });
});

// List club signups (prototype: no auth — add some before going wide).
app.get('/v1/members', (req, res) => {
  const members = db.prepare('SELECT id, name, contact, created_at FROM members ORDER BY created_at DESC').all();
  res.json({ count: members.length, members });
});

// Health check
app.get('/v1/health', (req, res) => res.json({ ok: true, service: 'dottodotdollars-agent-hire', time: now() }));

// Landing page
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Agent Hire API listening on :${PORT}`));
