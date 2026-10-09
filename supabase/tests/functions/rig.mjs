// rig.mjs
// LOCAL TESTING ONLY. Builds a small copy of how Supabase is wired, on this computer, so the real
// create-quote function can be run against it:
//
//   test --> [Deno running the REAL supabase/functions/create-quote/index.ts]
//                 |  uses the REAL @supabase/supabase-js
//                 v
//            gateway (this file) --/rest/v1--> PostgREST (the real program Supabase uses) --> Postgres 16 with our migration
//                                \--/auth/v1/user--> a stand-in for Supabase Auth (checks the token signature, nothing else)
//
// What is real: Deno, supabase-js, PostgREST, Postgres, our migration, our row level security.
// What is a stand-in: the gateway, Supabase Auth, the API keys (here they are plain JWTs, not sb_publishable_/sb_secret_).
//
// Needs: Postgres server programs (PGBIN), the PostgREST program (POSTGREST_BIN), Deno (DENO_BIN), Node.
// Postgres refuses to run as root, so when this runs as root it uses `runuser -u postgres`.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

export const JWT_SECRET = 'local-test-secret-local-test-secret-1234567890'; // test only, never a real secret
const PORTS = { pg: 54332, rest: 54333, gateway: 54334, fn: 54335, admin: 54336 };

// ---------------------------------------------------------------- tokens
const b64u = (x) => Buffer.from(x).toString('base64url');

export function signJwt(payload, secret = JWT_SECRET) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function verifyJwt(token, secret = JWT_SECRET) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (typeof payload.exp === 'number' && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

const inOneHour = () => Math.floor(Date.now() / 1000) + 3600;
export const userToken = (sub, extra = {}) => signJwt({ sub, role: 'authenticated', aud: 'authenticated', exp: inOneHour(), ...extra });
export const serviceRoleToken = () => signJwt({ role: 'service_role', exp: inOneHour() });
export const anonToken = () => signJwt({ role: 'anon', exp: inOneHour() });

// ---------------------------------------------------------------- the rig
export async function startRig({ log = () => {}, extraMigrations = [], withFunction = true } = {}) {
  const PGBIN = process.env.PGBIN || '/usr/lib/postgresql/16/bin';
  const POSTGREST_BIN = process.env.POSTGREST_BIN;
  const DENO_BIN = process.env.DENO_BIN || 'deno';
  for (const [name, file] of [['PGBIN/pg_ctl', `${PGBIN}/pg_ctl`], ['POSTGREST_BIN', POSTGREST_BIN]]) {
    if (!file || !existsSync(file)) throw new Error(`Cannot find ${name} (${file}). Set PGBIN / POSTGREST_BIN / DENO_BIN.`);
  }

  const asRoot = process.getuid?.() === 0;
  const as = (cmd, args) => (asRoot ? ['runuser', ['-u', 'postgres', '--', cmd, ...args]] : [cmd, args]);
  const run = (cmd, args, opts = {}) => {
    const [c, a] = as(cmd, args);
    const r = spawnSync(c, a, { encoding: 'utf8', ...opts });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr}${r.stdout}`);
    return r;
  };

  const base = asRoot ? `/var/lib/postgresql/fs-e2e-${process.pid}` : `${process.env.TMPDIR || '/tmp'}/fs-e2e-${process.pid}`;
  const data = `${base}/data`;
  const sock = `${base}/sock`;
  const children = [];
  let gateway;

  const cleanup = async () => {
    for (const c of children) {
      try { c.kill('SIGTERM'); } catch { /* already gone */ }
    }
    await new Promise((resolve) => (gateway ? gateway.close(() => resolve()) : resolve()));
    gateway?.closeAllConnections?.();
    try { run(`${PGBIN}/pg_ctl`, ['-D', data, '-m', 'immediate', 'stop']); } catch { /* not running */ }
    try { run('rm', ['-rf', base]); } catch { /* ignore */ }
  };

  try {
    run('rm', ['-rf', base]);
    run('mkdir', ['-p', sock]);
    run(`${PGBIN}/initdb`, ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8']);
    run(`${PGBIN}/pg_ctl`, ['-D', data, '-o', `-p ${PORTS.pg} -k ${sock} -c listen_addresses=''`, '-l', `${base}/log`, '-w', 'start']);

    const pgEnv = { ...process.env, PGHOST: sock, PGPORT: String(PORTS.pg), PGUSER: 'postgres', PGDATABASE: 'postgres' };
    const psqlFile = (file) => {
      const r = spawnSync(`${PGBIN}/psql`, ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-f', file], { env: pgEnv, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`psql -f ${file} failed:\n${r.stderr}`);
    };
    // sql(text) -> array of rows (each row an array of strings), as the postgres superuser
    const sql = (text) => {
      const r = spawnSync(`${PGBIN}/psql`, ['-X', '-q', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1'], { env: pgEnv, encoding: 'utf8', input: text });
      if (r.status !== 0) throw new Error(`SQL failed:\n${r.stderr}\n${text.slice(0, 300)}`);
      return r.stdout.trim() === '' ? [] : r.stdout.trim().split('\n').map((l) => l.split('|'));
    };

    psqlFile(`${ROOT}/supabase/tests/support/00_supabase_stub.sql`);
    psqlFile(process.env.MIGRATION || `${ROOT}/supabase/migrations/20261009120000_core_schema.sql`);
    for (const migration of extraMigrations) psqlFile(migration);   // later steps (for example Step 4), applied in order
    // Supabase connects PostgREST as a login role called "authenticator" that can switch to the three API roles.
    sql(`create role authenticator login noinherit;
         grant anon, authenticated, service_role to authenticator;
         grant usage on schema public to authenticator;`);

    // PostgREST, the program that turns the tables into a web API (the same one Supabase runs).
    const rest = spawn(POSTGREST_BIN, [], {
      env: {
        ...process.env,
        PGRST_DB_URI: `postgres://authenticator@/postgres?host=${encodeURIComponent(sock)}&port=${PORTS.pg}`,
        PGRST_DB_SCHEMAS: 'public',
        PGRST_DB_ANON_ROLE: 'anon',
        PGRST_JWT_SECRET: JWT_SECRET,
        PGRST_SERVER_HOST: '127.0.0.1',
        PGRST_SERVER_PORT: String(PORTS.rest),
        PGRST_ADMIN_SERVER_PORT: String(PORTS.admin),
        PGRST_DB_POOL: '4',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(rest);
    let restLog = '';
    rest.stdout.on('data', (d) => (restLog += d));
    rest.stderr.on('data', (d) => (restLog += d));
    await waitFor(async () => (await fetch(`http://127.0.0.1:${PORTS.admin}/ready`)).status === 200, 'PostgREST', () => restLog);

    // The gateway: Supabase puts one of these in front of everything.
    const logins = new Map();   // email -> { password, sub, extra }: the sign-in stand-in, used by the admin page test
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info', 'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS' };
    gateway = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://gateway');
      if (url.pathname === '/auth/v1/token') {
        // Stand-in for Supabase Auth password sign-in: only the emails registered with registerLogin() can sign in.
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
        let raw = '';
        req.on('data', (d) => (raw += d));
        req.on('end', () => {
          for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
          res.setHeader('content-type', 'application/json');
          let body = {};
          try { body = JSON.parse(raw); } catch { /* empty */ }
          const known = logins.get(String(body.email));
          if (url.searchParams.get('grant_type') !== 'password' || !known || known.password !== body.password) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }));
          }
          res.end(JSON.stringify({ access_token: userToken(known.sub, known.extra), token_type: 'bearer', expires_in: 3600, user: { id: known.sub, email: body.email } }));
        });
        return;
      }
      if (url.pathname === '/auth/v1/user') {
        // Stand-in for Supabase Auth: accepts a validly signed user token, refuses everything else.
        const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
        const claims = m ? verifyJwt(m[1]) : null;
        res.setHeader('content-type', 'application/json');
        if (!m) { res.statusCode = 401; return res.end(JSON.stringify({ code: 401, error_code: 'no_authorization', msg: 'This endpoint requires a Bearer token' })); }
        if (!claims || !claims.sub) { res.statusCode = 403; return res.end(JSON.stringify({ code: 403, error_code: 'bad_jwt', msg: 'invalid JWT' })); }
        return res.end(JSON.stringify({ id: claims.sub, aud: 'authenticated', role: 'authenticated', email: `${claims.sub}@example.test` }));
      }
      if (url.pathname.startsWith('/rest/v1/')) {
        const upstream = http.request(
          { host: '127.0.0.1', port: PORTS.rest, method: req.method, path: url.pathname.slice('/rest/v1'.length) + url.search, headers: { ...req.headers, host: `127.0.0.1:${PORTS.rest}` } },
          (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); },
        );
        upstream.on('error', () => { res.statusCode = 502; res.end(); });
        return req.pipe(upstream);
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise((resolve) => gateway.listen(PORTS.gateway, '127.0.0.1', resolve));

    let denoLog = '';
    if (withFunction) {
      // The REAL function, run by Deno, with the same environment variables Supabase provides.
      const denoCert = process.env.DENO_CERT || (existsSync('/root/.ccr/ca-bundle.crt') ? '/root/.ccr/ca-bundle.crt' : undefined);
      const fnPath = `${ROOT}/supabase/functions/create-quote/index.ts`;
      const deno = spawn(DENO_BIN, ['run', '--node-modules-dir=none', '--no-lock', '--allow-net', '--allow-env', '--allow-read', fnPath], {
        env: {
          ...process.env,
          ...(denoCert ? { DENO_CERT: denoCert } : {}),
          DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${PORTS.fn}`,
          SUPABASE_URL: `http://127.0.0.1:${PORTS.gateway}`,
          SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: anonToken() }),
          SUPABASE_SECRET_KEYS: JSON.stringify({ default: serviceRoleToken() }),
          ...(process.env.RIG_FN_ENV ? JSON.parse(process.env.RIG_FN_ENV) : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(deno);
      deno.stdout.on('data', (d) => (denoLog += d));
      deno.stderr.on('data', (d) => (denoLog += d));
      await waitFor(async () => (await fetch(`http://127.0.0.1:${PORTS.fn}/`, { method: 'OPTIONS' })).status === 200, 'Deno function', () => denoLog, 120_000);
    }

    return {
      sql,
      functionUrl: `http://127.0.0.1:${PORTS.fn}/`,
      restUrl: `http://127.0.0.1:${PORTS.gateway}/rest/v1`,
      denoLog: () => denoLog,
      gatewayUrl: `http://127.0.0.1:${PORTS.gateway}`,
      registerLogin: (email, password, sub, extra = {}) => logins.set(email, { password, sub, extra }),
      stop: cleanup,
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

async function waitFor(check, what, logOf, timeoutMs = 30_000) {
  const start = Date.now();
  for (;;) {
    try { if (await check()) return; } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`${what} did not start within ${timeoutMs / 1000}s.\n${logOf()}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
