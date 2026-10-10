/**
 * Tiny local stand-in for a Supabase project, for testing sync without a
 * real project. Dev only — NOT secure.
 *
 *   /rest/v1/*  → proxied to PostgREST (real RLS from supabase/schema.sql)
 *   /auth/v1/*  → minimal fake GoTrue: signup, password + refresh_token grants,
 *                 user, logout, otp, recover (all auto-confirmed)
 *
 * Requires: Postgres DB "spellbook" with bootstrap.sql + schema.sql applied,
 * and the PostgREST binary. Usage: node server.mjs [/path/to/postgrest]
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import pg from 'pg';

export const JWT_SECRET = 'spellbook-local-dev-secret-at-least-32-chars!!';
const PORT = 54321, PGRST_PORT = 3001;
const b64u = (b) => Buffer.from(b).toString('base64url');
export function jwt(claims) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), p = b64u(JSON.stringify(claims));
  return `${h}.${p}.${crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`;
}
export const ANON_KEY = jwt({ role: 'anon', iss: 'supabase-mock', exp: 4102444800 });

const db = new pg.Pool({ connectionString: process.env.MOCK_DB || 'postgres://mockadmin:mockpass@localhost:5432/spellbook' });
const refresh = new Map(); // refresh_token -> user id

const bin = process.argv[2] || './postgrest';
fs.writeFileSync('/tmp/pgrst.conf', `db-uri = "postgres://authenticator:authpass@localhost:5432/spellbook"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "${JWT_SECRET}"
server-port = ${PGRST_PORT}
`);
const pgrst = spawn(bin, ['/tmp/pgrst.conf'], { stdio: 'inherit' });
process.on('exit', () => pgrst.kill());
process.on('SIGTERM', () => process.exit(0));

async function session(u) {
  const now = Math.floor(Date.now() / 1000);
  const rt = crypto.randomUUID(); refresh.set(rt, u.id);
  const user = { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, app_metadata: { provider: 'email' }, user_metadata: {}, created_at: new Date().toISOString() };
  return { access_token: jwt({ sub: u.id, role: 'authenticated', aud: 'authenticated', email: u.email, exp: now + 3600, iat: now }), token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: rt, user };
}
function userFromAuth(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  try { const c = JSON.parse(Buffer.from(t.split('.')[1], 'base64url')); return c.sub ? { id: c.sub, email: c.email } : null; } catch { return null; }
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Expose-Headers': '*' };
const send = (res, code, body) => { res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' }); res.end(body == null ? '' : JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/rest/v1/')) {
      const body = await readBody(req);
      const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
      const r = await fetch(`http://localhost:${PGRST_PORT}${url.pathname.slice(8)}${url.search}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
      const out = Buffer.from(await r.arrayBuffer());
      const h = { ...CORS }; r.headers.forEach((v, k) => { if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k) && !k.startsWith('access-control-')) h[k] = v; });
      res.writeHead(r.status, h); return res.end(out);
    }
    if (url.pathname.startsWith('/auth/v1/')) {
      const path = url.pathname.slice(9);
      const body = req.method === 'GET' ? {} : JSON.parse((await readBody(req)) || '{}');
      if (path === 'signup') {
        const id = crypto.randomUUID();
        const r = await db.query('insert into auth.users (id,email,password) values ($1,$2,$3) on conflict (email) do nothing returning *', [id, body.email, body.password]);
        if (!r.rows.length) return send(res, 422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' });
        return send(res, 200, await session(r.rows[0]));
      }
      if (path === 'token' && url.searchParams.get('grant_type') === 'password') {
        const r = await db.query('select * from auth.users where email=$1 and password=$2', [body.email, body.password]);
        if (!r.rows.length) return send(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        return send(res, 200, await session(r.rows[0]));
      }
      if (path === 'token' && url.searchParams.get('grant_type') === 'refresh_token') {
        const id = refresh.get(body.refresh_token);
        const r = id && (await db.query('select * from auth.users where id=$1', [id]));
        if (!r?.rows.length) return send(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
        return send(res, 200, await session(r.rows[0]));
      }
      if (path === 'user') { const u = userFromAuth(req); return u ? send(res, 200, { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, app_metadata: {}, user_metadata: {} }) : send(res, 401, { msg: 'no user' }); }
      if (path === 'logout') return send(res, 204);
      if (path === 'otp' || path === 'recover') return send(res, 200, {});
      return send(res, 404, { msg: 'not implemented in mock: ' + path });
    }
    send(res, 404, { msg: 'not found' });
  } catch (e) { console.error(e); send(res, 500, { msg: e.message }); }
}).listen(PORT, () => console.log(`supabase-mock on http://localhost:${PORT}  anon key: ${ANON_KEY}`));
