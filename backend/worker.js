const ORIGINS = new Set([
  'https://shumniyvlad-cell.github.io',
  'http://127.0.0.1:8766',
  'http://localhost:8766'
]);
const MAX_BODY = 256 * 1024;

function cors(origin) {
  if (!ORIGINS.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    Vary: 'Origin'
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin) }
  });
}

async function body(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY) throw new Error('Слишком большой запрос');
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw new Error('Слишком большой запрос');
  try { return raw ? JSON.parse(raw) : {}; }
  catch (_) { throw new Error('Некорректные данные'); }
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

async function sameSecret(a, b) {
  const encoder = new TextEncoder();
  const pair = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(a || ''))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(b || '')))
  ]);
  const left = new Uint8Array(pair[0]);
  const right = new Uint8Array(pair[1]);
  let different = 0;
  for (let i = 0; i < left.length; i++) different |= left[i] ^ right[i];
  return different === 0;
}

async function auth(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || token.length > 80) return null;
  const session = await env.DB.prepare(
    'SELECT p.id, p.role, p.display_name FROM sessions s JOIN profiles p ON p.id=s.profile_id WHERE s.token=? AND s.expires_at>?'
  ).bind(token, new Date().toISOString()).first();
  return session || null;
}

async function login(request, env, origin) {
  const input = await body(request);
  const role = input.role === 'mentor' ? 'mentor' : input.role === 'participant' ? 'participant' : '';
  const secret = role === 'mentor' ? env.SASHA_TEST_CODE : env.MILA_TEST_CODE;
  if (!role || !(await sameSecret(input.code, secret))) {
    return json({ error: 'Неверный код доступа' }, 401, origin);
  }
  const profileId = role === 'mentor' ? 'sasha' : 'mila';
  const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(new Date().toISOString()).run();
  await env.DB.prepare('INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, ?)').bind(token, profileId, expires).run();
  const profile = await env.DB.prepare('SELECT id, role, display_name FROM profiles WHERE id=?').bind(profileId).first();
  return json({ token, profile, expiresAt: expires }, 200, origin);
}

async function participantSnapshot(env) {
  const state = await env.DB.prepare('SELECT state_json, updated_at FROM participant_state WHERE participant_id=?').bind('mila').first();
  const reviews = await env.DB.prepare('SELECT status, comment, created_at FROM result_reviews ORDER BY created_at DESC LIMIT 10').all();
  const messages = await env.DB.prepare(
    'SELECT author_id, body, created_at FROM mentor_messages ORDER BY created_at DESC LIMIT 30'
  ).all();
  return { state: state ? JSON.parse(state.state_json) : null, updatedAt: state ? state.updated_at : null, reviews: reviews.results || [], messages: (messages.results || []).reverse() };
}

async function saveState(request, env, profile, origin) {
  if (profile.role !== 'participant') return json({ error: 'Недостаточно прав' }, 403, origin);
  const input = await body(request);
  if (!input.state || typeof input.state !== 'object' || Array.isArray(input.state)) return json({ error: 'Нет данных маршрута' }, 400, origin);
  const packed = JSON.stringify(input.state);
  if (packed.length > 180000) return json({ error: 'Слишком большой маршрут' }, 413, origin);
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO participant_state (participant_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(participant_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at'
  ).bind('mila', packed, now).run();
  return json({ ok: true, updatedAt: now }, 200, origin);
}

async function sendMessage(request, env, profile, origin) {
  const input = await body(request);
  const text = cleanText(input.text, 700);
  if (!text) return json({ error: 'Напиши сообщение' }, 400, origin);
  const createdAt = new Date().toISOString();
  await env.DB.prepare('INSERT INTO mentor_messages (id, author_id, body, created_at) VALUES (?, ?, ?, ?)')
    .bind(crypto.randomUUID(), profile.id, text, createdAt).run();
  return json({ ok: true, createdAt }, 200, origin);
}

async function reviewResult(request, env, profile, origin) {
  if (profile.role !== 'mentor') return json({ error: 'Недостаточно прав' }, 403, origin);
  const input = await body(request);
  const status = input.status === 'approved' ? 'approved' : input.status === 'needs_clarification' ? 'needs_clarification' : '';
  const comment = cleanText(input.comment, 700);
  if (!status || !comment) return json({ error: 'Укажи решение и комментарий' }, 400, origin);
  const createdAt = new Date().toISOString();
  await env.DB.prepare('INSERT INTO result_reviews (id, reviewer_id, status, comment, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), profile.id, status, comment, createdAt).run();
  return json({ ok: true, createdAt }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (origin && !ORIGINS.has(origin)) return json({ error: 'Источник не разрешён' }, 403, origin);
    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') return json({ ok: true }, 200, origin);
      if (url.pathname === '/v1/login' && request.method === 'POST') return login(request, env, origin);
      const profile = await auth(request, env);
      if (!profile) return json({ error: 'Нужен вход' }, 401, origin);
      if (url.pathname === '/v1/snapshot' && request.method === 'GET') return json({ profile, ...(await participantSnapshot(env)) }, 200, origin);
      if (url.pathname === '/v1/state' && request.method === 'PUT') return saveState(request, env, profile, origin);
      if (url.pathname === '/v1/messages' && request.method === 'POST') return sendMessage(request, env, profile, origin);
      if (url.pathname === '/v1/reviews' && request.method === 'POST') return reviewResult(request, env, profile, origin);
      return json({ error: 'Маршрут не найден' }, 404, origin);
    } catch (error) {
      console.log(JSON.stringify({ error: String(error), path: url.pathname }));
      return json({ error: error instanceof Error ? error.message : 'Ошибка сервера' }, 500, origin);
    }
  }
};
