# Make TTUM data survive restarts — Turso setup (free, $0)

## Why this is needed

Render's free web service wipes its local files on every restart/redeploy.
That is why live jobs, members and visit stats previously went to 0.
The server now uses Turso (hosted SQLite, same SQL dialect) when two
environment variables are set, and falls back to a local file otherwise.
Until those two variables are set in Render, data will still be wiped
on the next restart — the code change alone does not fix it.

## Exact steps (Mat, on your own device — no passwords to anyone)

1. Go to https://turso.tech and sign up / sign in with your own account
   (GitHub or email — your choice). The free tier is $0, no card needed
   for this size of site (generous free limits: several GB storage,
   hundreds of millions of row reads a month).
2. Create one database. Suggested name: `ttum` (any name works).
   Pick the closest region if it asks (e.g. US West).
3. In the Turso dashboard for that database, copy two values:
   - Database URL — looks like `libsql://ttum-xxxx.turso.io`
   - Auth token — a long token string. Treat it like a password:
     paste it only into Render, never into chat, email, or git.
4. Go to the Render dashboard → service "Triple Thumbs Up Mindset
   Project" → Environment → Add Environment Variable, twice:
   - Key: `TURSO_DATABASE_URL`, Value: the database URL from step 3
   - Key: `TURSO_AUTH_TOKEN`, Value: the auth token from step 3
5. Save, then trigger Manual Deploy → Deploy latest commit in Render.
6. Check https://agent-hire.onrender.com/v1/health — it should say
   `"db_backend": "turso"` instead of `"local-sqlite"`.
   Only then is data persistent. After that, create a test member/job,
   redeploy, and check it is still there before relying on it.

## What NOT to do

- Do NOT paste the auth token into chat, a file in this repo, or
  anywhere public. If it ever leaks, rotate it in Turso (create a new
  token, replace the Render variable, delete the old one).
- Do NOT buy Render's persistent disk or paid Postgres to fix this:
  disk needs a paid ($7/mo+) web service to attach, and Render's free
  Postgres expires after 30 days and is then deleted — neither is a
  free permanent fix.
- Old live data (jobs/members/stats recorded before this change) was
  already lost in the wipes and cannot be recovered from Turso — the
  new database starts empty.

## If Turso is not wanted

The fallback remains the local file, but then every restart/redeploy
will keep wiping data. There is no free, no-account persistent option
on Render's free tier itself — that is a platform limit, not a code bug.
