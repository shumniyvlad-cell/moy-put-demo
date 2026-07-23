import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const MAX_BODY = 200_000;
const COOKIE_NAME = 'mp_session';
let schemaReady = null;

function send(res, status, payload, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
  res.end(JSON.stringify(payload));
}

function getDb() {
  if (!process.env.DATABASE_URL) throw new Error('База данных ещё не подключена');
  return neon(process.env.DATABASE_URL);
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = getDb();
      await sql`CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('participant', 'mentor')),
        display_name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS participant_state (
        participant_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
        state_json TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS mentor_messages (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS result_reviews (
        id TEXT PRIMARY KEY,
        reviewer_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('approved', 'needs_clarification')),
        comment TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`INSERT INTO profiles (id, role, display_name) VALUES
        ('mila', 'participant', 'Мила'), ('sasha', 'mentor', 'Саша')
        ON CONFLICT (id) DO NOTHING`;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function parseCookie(header = '') {
  return header.split(';').map((part) => part.trim()).reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index)] = decodeURIComponent(part.slice(index + 1));
    return cookies;
  }, {});
}

function cookie(token, maxAge = 60 * 60 * 24 * 7) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Слишком большой запрос');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Некорректные данные'); }
}

function cleanText(value, max = 700) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function isSameSecret(value, expected) {
  if (!expected || typeof value !== 'string') return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function currentProfile(req) {
  const token = parseCookie(req.headers.cookie)[COOKIE_NAME];
  if (!token || token.length > 180) return null;
  const sql = getDb();
  const rows = await sql`SELECT p.id, p.role, p.display_name AS "displayName"
    FROM sessions s JOIN profiles p ON p.id = s.profile_id
    WHERE s.token = ${token} AND s.expires_at > NOW()`;
  return rows[0] || null;
}

async function snapshot() {
  const sql = getDb();
  const [stateRows, messages, reviews] = await Promise.all([
    sql`SELECT state_json AS "stateJson", updated_at AS "updatedAt" FROM participant_state WHERE participant_id = 'mila'`,
    sql`SELECT m.author_id AS "authorId", p.display_name AS "authorName", m.body, m.created_at AS "createdAt"
      FROM mentor_messages m JOIN profiles p ON p.id = m.author_id ORDER BY m.created_at ASC LIMIT 80`,
    sql`SELECT status, comment, created_at AS "createdAt" FROM result_reviews ORDER BY created_at DESC LIMIT 20`
  ]);
  let state = null;
  if (stateRows[0]) {
    try { state = JSON.parse(stateRows[0].stateJson); }
    catch { state = null; }
  }
  return { state, updatedAt: stateRows[0]?.updatedAt || null, messages, reviews };
}

async function login(req, res) {
  const input = await readJson(req);
  const role = input.role === 'mentor' ? 'mentor' : input.role === 'participant' ? 'participant' : '';
  const expected = role === 'mentor' ? process.env.SASHA_TEST_CODE : process.env.MILA_TEST_CODE;
  if (!role || !isSameSecret(input.code, expected)) return send(res, 401, { error: 'Неверный код доступа' });
  const profileId = role === 'mentor' ? 'sasha' : 'mila';
  const token = crypto.randomBytes(32).toString('base64url');
  const sql = getDb();
  await sql`DELETE FROM sessions WHERE expires_at <= NOW()`;
  await sql`INSERT INTO sessions (token, profile_id, expires_at) VALUES (${token}, ${profileId}, NOW() + INTERVAL '7 days')`;
  const profile = { id: profileId, role, displayName: role === 'mentor' ? 'Саша' : 'Мила' };
  return send(res, 200, { profile, ...(await snapshot()) }, { 'Set-Cookie': cookie(token) });
}

async function saveState(req, res, profile) {
  if (profile.role !== 'participant') return send(res, 403, { error: 'Только участник может менять маршрут' });
  const input = await readJson(req);
  if (!input.state || typeof input.state !== 'object' || Array.isArray(input.state)) return send(res, 400, { error: 'Нет данных маршрута' });
  const packed = JSON.stringify(input.state);
  if (packed.length > 180_000) return send(res, 413, { error: 'Слишком большой маршрут' });
  const sql = getDb();
  await sql`INSERT INTO participant_state (participant_id, state_json, updated_at)
    VALUES ('mila', ${packed}, NOW())
    ON CONFLICT (participant_id) DO UPDATE SET state_json = EXCLUDED.state_json, updated_at = NOW()`;
  return send(res, 200, { ok: true });
}

async function addMessage(req, res, profile) {
  const input = await readJson(req);
  const text = cleanText(input.text);
  if (!text) return send(res, 400, { error: 'Напиши сообщение' });
  const sql = getDb();
  await sql`INSERT INTO mentor_messages (id, author_id, body) VALUES (${crypto.randomUUID()}, ${profile.id}, ${text})`;
  return send(res, 200, { ok: true });
}

async function reviewResult(req, res, profile) {
  if (profile.role !== 'mentor') return send(res, 403, { error: 'Только наставник может проверять результат' });
  const input = await readJson(req);
  const status = input.status === 'approved' || input.status === 'needs_clarification' ? input.status : '';
  const comment = cleanText(input.comment);
  if (!status || !comment) return send(res, 400, { error: 'Укажи решение и комментарий' });
  const sql = getDb();
  await sql`INSERT INTO result_reviews (id, reviewer_id, status, comment) VALUES (${crypto.randomUUID()}, ${profile.id}, ${status}, ${comment})`;
  const stateRows = await sql`SELECT state_json AS "stateJson" FROM participant_state WHERE participant_id = 'mila'`;
  if (stateRows[0]) {
    try {
      const state = JSON.parse(stateRows[0].stateJson);
      const pending = state?.goal?.pending;
      if (pending && state.goal) {
        if (status === 'approved') {
          state.goal.current = Number(pending.value) || state.goal.current || 0;
          delete state.goal.pending;
        } else {
          state.goal.pending = { ...pending, reviewStatus: status, reviewComment: comment };
        }
        await sql`UPDATE participant_state SET state_json = ${JSON.stringify(state)}, updated_at = NOW() WHERE participant_id = 'mila'`;
      }
    } catch { /* malformed client state is left untouched */ }
  }
  return send(res, 200, { ok: true });
}

export default async function handler(req, res) {
  // On Vercel catch-all functions `req.query.path` differs between local dev
  // and production. The URL is the stable source of the requested API path.
  const pathname = new URL(req.url || '/', 'https://moy-put.local').pathname;
  const route = pathname === '/api' ? '/' : pathname.replace(/^\/api(?=\/|$)/, '');
  try {
    await ensureSchema();
    if (req.method === 'GET' && route === '/health') return send(res, 200, { ok: true, storage: 'neon-postgres' });
    if (req.method === 'POST' && route === '/login') return login(req, res);
    if (req.method === 'POST' && route === '/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
    const profile = await currentProfile(req);
    if (!profile) return send(res, 401, { error: 'Нужен тестовый вход' });
    if (req.method === 'GET' && route === '/snapshot') return send(res, 200, { profile, ...(await snapshot()) });
    if (req.method === 'PUT' && route === '/state') return saveState(req, res, profile);
    if (req.method === 'POST' && route === '/messages') return addMessage(req, res, profile);
    if (req.method === 'POST' && route === '/reviews') return reviewResult(req, res, profile);
    return send(res, 404, { error: 'Маршрут не найден' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ошибка сервера';
    const status = message === 'База данных ещё не подключена' ? 503 : 500;
    return send(res, status, { error: message });
  }
}
