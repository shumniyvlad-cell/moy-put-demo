import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { enqueueProfileReminders } from '../lib/reminders.js';

const MAX_BODY = 750_000;
const COOKIE_NAME = 'mp_session';
const SESSION_SECONDS = 60 * 60 * 24 * 180;
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
        contact TEXT NOT NULL DEFAULT '',
        registered_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS contact TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ`;
      await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS telegram_user_id TEXT`;
      await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS consented_at TIMESTAMPTZ`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS profiles_telegram_user_id_idx
        ON profiles (telegram_user_id) WHERE telegram_user_id IS NOT NULL`;
      await sql`CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS device_credentials (
        credential_hash TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS participant_state (
        participant_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
        state_json TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS personal_states (
        profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
        state_json TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS mentor_messages (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        participant_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`ALTER TABLE mentor_messages ADD COLUMN IF NOT EXISTS participant_id TEXT REFERENCES profiles(id) ON DELETE CASCADE`;
      await sql`CREATE TABLE IF NOT EXISTS result_reviews (
        id TEXT PRIMARY KEY,
        reviewer_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        participant_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('approved', 'needs_clarification')),
        comment TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`ALTER TABLE result_reviews ADD COLUMN IF NOT EXISTS participant_id TEXT REFERENCES profiles(id) ON DELETE CASCADE`;
      await sql`CREATE TABLE IF NOT EXISTS result_submissions (
        id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        area_id TEXT NOT NULL,
        value DOUBLE PRECISION NOT NULL,
        unit TEXT NOT NULL DEFAULT '',
        evidence_text TEXT NOT NULL DEFAULT '',
        proof_name TEXT NOT NULL DEFAULT '',
        proof_type TEXT NOT NULL DEFAULT '',
        proof_data TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'needs_clarification')),
        reviewer_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
        review_comment TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ
      )`;
      await sql`CREATE TABLE IF NOT EXISTS mentor_feedback (
        participant_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
        mentor_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        review TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`INSERT INTO profiles (id, role, display_name) VALUES
        ('mila', 'participant', 'Мила'), ('sasha', 'mentor', 'Саша')
        ON CONFLICT (id) DO NOTHING`;
      await sql`UPDATE mentor_messages SET participant_id = CASE WHEN author_id = 'sasha' THEN 'mila' ELSE author_id END
        WHERE participant_id IS NULL`;
      await sql`UPDATE result_reviews SET participant_id = 'mila' WHERE participant_id IS NULL`;
      await sql`CREATE INDEX IF NOT EXISTS mentor_messages_participant_idx ON mentor_messages (participant_id, created_at)`;
      await sql`CREATE INDEX IF NOT EXISTS result_reviews_participant_idx ON result_reviews (participant_id, created_at)`;
      await sql`CREATE INDEX IF NOT EXISTS participant_state_updated_idx ON participant_state (updated_at DESC)`;
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

function cookie(token, maxAge = SESSION_SECONDS) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body) > MAX_BODY) throw new Error('Слишком большой запрос');
    try { return JSON.parse(req.body); }
    catch { throw new Error('Некорректные данные'); }
  }
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

function cleanDeviceToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,180}$/.test(value) ? value : '';
}

function deviceCredentialHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function telegramIdentity(initData) {
  if (!initData) return null;
  if (typeof initData !== 'string' || initData.length > 12_000) throw new Error('Некорректные данные Telegram');
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Вход через Telegram пока недоступен');
  const params = new URLSearchParams(initData);
  const suppliedHash = params.get('hash') || '';
  if (!/^[a-f0-9]{64}$/i.test(suppliedHash)) throw new Error('Telegram не подтвердил вход');
  params.delete('hash');
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > 60 * 60 * 24 * 7) {
    throw new Error('Сессия Telegram устарела. Открой приложение из бота ещё раз');
  }
  const dataCheckString = [...params.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!isSameSecret(suppliedHash.toLowerCase(), expected)) throw new Error('Telegram не подтвердил вход');
  let user;
  try { user = JSON.parse(params.get('user') || '{}'); }
  catch { throw new Error('Telegram не передал профиль'); }
  if (!user?.id) throw new Error('Telegram не передал профиль');
  return {
    id: String(user.id),
    displayName: cleanText([user.first_name, user.last_name].filter(Boolean).join(' '), 60),
    contact: user.username ? `@${cleanText(user.username, 64)}` : ''
  };
}

async function issueSession(sql, profileId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await sql`DELETE FROM sessions WHERE expires_at <= NOW()`;
  await sql`INSERT INTO sessions (token, profile_id, expires_at)
    VALUES (${token}, ${profileId}, NOW() + INTERVAL '180 days')`;
  return token;
}

async function currentProfile(req) {
  const token = parseCookie(req.headers.cookie)[COOKIE_NAME];
  if (!token || token.length > 180) return null;
  const sql = getDb();
  const rows = await sql`SELECT p.id, p.role, p.display_name AS "displayName", p.contact,
    (p.telegram_user_id IS NOT NULL) AS "telegramLinked",
    (p.registered_at IS NOT NULL) AS "registered"
    FROM sessions s JOIN profiles p ON p.id = s.profile_id
    WHERE s.token = ${token} AND s.expires_at > NOW()`;
  return rows[0] || null;
}

function parseStoredState(value) {
  try { return value ? JSON.parse(value) : null; }
  catch { return null; }
}

async function participantDirectory(sql) {
  const rows = await sql`SELECT p.id, p.display_name AS "displayName", p.contact,
    s.state_json AS "stateJson", s.updated_at AS "updatedAt"
    FROM profiles p LEFT JOIN participant_state s ON s.participant_id = p.id
    WHERE p.role = 'participant' AND p.registered_at IS NOT NULL
    ORDER BY COALESCE(s.updated_at, p.registered_at, p.created_at) DESC`;
  return rows.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    contact: row.contact,
    state: parseStoredState(row.stateJson),
    updatedAt: row.updatedAt || null
  }));
}

async function snapshot(profile, requestedParticipantId = '') {
  const sql = getDb();
  const participants = profile?.role === 'mentor' ? await participantDirectory(sql) : [];
  const participantId = profile?.role === 'participant'
    ? profile.id
    : participants.some((item) => item.id === requestedParticipantId)
      ? requestedParticipantId
      : participants.find((item) => item.id === 'mila')?.id || participants[0]?.id || '';
  const participant = participants.find((item) => item.id === participantId) || null;
  const [stateRows, personalRows, messages, reviews, submissions, feedbackRows, mentorRows] = await Promise.all([
    participantId
      ? sql`SELECT state_json AS "stateJson", updated_at AS "updatedAt" FROM participant_state WHERE participant_id = ${participantId}`
      : Promise.resolve([]),
    profile?.role === 'mentor'
      ? sql`SELECT state_json AS "stateJson", updated_at AS "updatedAt" FROM personal_states WHERE profile_id = ${profile.id}`
      : Promise.resolve([]),
    participantId
      ? sql`SELECT m.author_id AS "authorId", p.display_name AS "authorName", m.body, m.created_at AS "createdAt"
          FROM mentor_messages m JOIN profiles p ON p.id = m.author_id
          WHERE m.participant_id = ${participantId} ORDER BY m.created_at ASC LIMIT 80`
      : Promise.resolve([]),
    participantId
      ? sql`SELECT status, comment, created_at AS "createdAt" FROM result_reviews
          WHERE participant_id = ${participantId} ORDER BY created_at DESC LIMIT 20`
      : Promise.resolve([]),
    participantId
      ? sql`SELECT id, area_id AS "areaId", value, unit, evidence_text AS evidence,
          proof_name AS "proofName", proof_type AS "proofType", proof_data AS "proofData",
          status, review_comment AS "reviewComment", created_at AS "createdAt", reviewed_at AS "reviewedAt"
          FROM result_submissions
          WHERE participant_id = ${participantId} AND status IN ('pending', 'needs_clarification')
          ORDER BY created_at DESC LIMIT 8`
      : Promise.resolve([]),
    participantId
      ? sql`SELECT rating, review, created_at AS "createdAt" FROM mentor_feedback
          WHERE participant_id = ${participantId} AND mentor_id = 'sasha'`
      : Promise.resolve([]),
    sql`SELECT display_name AS "displayName" FROM profiles WHERE id = 'sasha'`
  ]);
  const state = parseStoredState(stateRows[0]?.stateJson);
  const personalState = parseStoredState(personalRows[0]?.stateJson);
  return {
    state,
    updatedAt: stateRows[0]?.updatedAt || null,
    personalState,
    personalUpdatedAt: personalRows[0]?.updatedAt || null,
    messages,
    reviews,
    resultSubmissions: submissions,
    mentorFeedback: feedbackRows[0] || null,
    mentorProfile: mentorRows[0] || { displayName: 'Саша' },
    selectedParticipantId: participantId || null,
    selectedParticipant: participant,
    participants
  };
}

async function login(req, res) {
  const input = await readJson(req);
  if (input.role !== 'mentor' || !isSameSecret(input.code, process.env.SASHA_TEST_CODE)) {
    return send(res, 401, { error: 'Неверный код наставника' });
  }
  const telegram = telegramIdentity(input.telegramInitData);
  const profileId = 'sasha';
  const sql = getDb();
  const profileRows = await sql`SELECT display_name AS "displayName", contact, telegram_user_id AS "telegramUserId",
    (registered_at IS NOT NULL) AS "registered" FROM profiles WHERE id = ${profileId}`;
  const saved = profileRows[0];
  if (!saved) return send(res, 404, { error: 'Профиль наставника не найден' });
  if (telegram) {
    const conflict = await sql`SELECT id FROM profiles WHERE telegram_user_id = ${telegram.id} AND id <> ${profileId}`;
    if (conflict[0]) return send(res, 409, { error: 'Этот Telegram уже привязан к другому профилю' });
  }
  await sql`UPDATE profiles SET registered_at = COALESCE(registered_at, NOW()),
    telegram_user_id = COALESCE(${telegram?.id || null}, telegram_user_id) WHERE id = ${profileId}`;
  const token = await issueSession(sql, profileId);
  const profile = { id: profileId, role: 'mentor', displayName: saved.displayName, contact: saved.contact, registered: true, telegramLinked: Boolean(telegram || saved.telegramUserId) };
  await enqueueRemindersQuietly(profileId);
  return send(res, 200, { profile, ...(await snapshot(profile)) }, { 'Set-Cookie': cookie(token) });
}

async function register(req, res) {
  const input = await readJson(req);
  const displayName = cleanText(input.name, 60);
  const contact = cleanText(input.contact, 100);
  if (displayName.length < 2) return send(res, 400, { error: 'Укажи имя минимум из 2 символов' });
  if (contact && contact.length < 3) return send(res, 400, { error: 'Проверь Telegram или телефон' });
  if (input.consent !== true) return send(res, 400, { error: 'Нужно согласие на обработку данных' });
  const deviceToken = cleanDeviceToken(input.deviceToken);
  const telegram = telegramIdentity(input.telegramInitData);
  if (!deviceToken && !telegram) return send(res, 400, { error: 'Не удалось сохранить вход на этом устройстве' });
  const sql = getDb();
  const credentialHash = deviceToken ? deviceCredentialHash(deviceToken) : '';
  let existingRows = telegram
    ? await sql`SELECT id, display_name AS "displayName", contact, telegram_user_id AS "telegramUserId"
        FROM profiles WHERE telegram_user_id = ${telegram.id} AND role = 'participant'`
    : [];
  if (!existingRows[0] && credentialHash) {
    existingRows = await sql`SELECT p.id, p.display_name AS "displayName", p.contact, p.telegram_user_id AS "telegramUserId"
      FROM device_credentials d JOIN profiles p ON p.id = d.profile_id
      WHERE d.credential_hash = ${credentialHash} AND p.role = 'participant'`;
  }
  let profileId = existingRows[0]?.id || `p_${crypto.randomUUID().replaceAll('-', '')}`;
  if (telegram) {
    const conflict = await sql`SELECT id FROM profiles WHERE telegram_user_id = ${telegram.id} AND id <> ${profileId}`;
    if (conflict[0]) return send(res, 409, { error: 'Этот Telegram уже привязан к другому профилю' });
  }
  const finalName = displayName || telegram?.displayName || existingRows[0]?.displayName;
  const finalContact = contact || telegram?.contact || existingRows[0]?.contact || '';
  if (existingRows[0]) {
    await sql`UPDATE profiles SET display_name = ${finalName}, contact = ${finalContact},
      telegram_user_id = COALESCE(telegram_user_id, ${telegram?.id || null}), registered_at = COALESCE(registered_at, NOW()),
      consented_at = NOW() WHERE id = ${profileId}`;
  } else {
    await sql`INSERT INTO profiles
      (id, role, display_name, contact, telegram_user_id, registered_at, consented_at)
      VALUES (${profileId}, 'participant', ${finalName}, ${finalContact}, ${telegram?.id || null}, NOW(), NOW())`;
  }
  if (credentialHash) {
    await sql`INSERT INTO device_credentials (credential_hash, profile_id, last_used_at)
      VALUES (${credentialHash}, ${profileId}, NOW())
      ON CONFLICT (credential_hash) DO UPDATE SET last_used_at = NOW()`;
  }
  const token = await issueSession(sql, profileId);
  const profile = { id: profileId, role: 'participant', displayName: finalName, contact: finalContact, registered: true, telegramLinked: Boolean(telegram || existingRows[0]?.telegramUserId) };
  await enqueueRemindersQuietly(profileId);
  return send(res, 201, { profile, ...(await snapshot(profile)) }, { 'Set-Cookie': cookie(token) });
}

async function resume(req, res) {
  const input = await readJson(req);
  const deviceToken = cleanDeviceToken(input.deviceToken);
  const telegram = telegramIdentity(input.telegramInitData);
  if (!deviceToken && !telegram) return send(res, 401, { error: 'Сохранённый вход не найден' });
  const sql = getDb();
  let rows = telegram
    ? await sql`SELECT id, role, display_name AS "displayName", contact, telegram_user_id AS "telegramUserId"
        FROM profiles WHERE telegram_user_id = ${telegram.id}`
    : [];
  if (!rows[0] && deviceToken) {
    rows = await sql`SELECT p.id, p.role, p.display_name AS "displayName", p.contact, p.telegram_user_id AS "telegramUserId"
      FROM device_credentials d JOIN profiles p ON p.id = d.profile_id
      WHERE d.credential_hash = ${deviceCredentialHash(deviceToken)} AND p.role = 'participant'`;
  }
  const profile = rows[0];
  if (!profile) return send(res, 401, { error: 'Сохранённый вход не найден' });
  if (telegram && telegram.id !== profile.telegramUserId) {
    const conflict = await sql`SELECT id FROM profiles WHERE telegram_user_id = ${telegram.id} AND id <> ${profile.id}`;
    if (conflict[0]) return send(res, 409, { error: 'Этот Telegram уже привязан к другому профилю' });
    await sql`UPDATE profiles SET telegram_user_id = ${telegram.id} WHERE id = ${profile.id}`;
  }
  if (deviceToken) {
    await sql`UPDATE device_credentials SET last_used_at = NOW()
      WHERE credential_hash = ${deviceCredentialHash(deviceToken)}`;
  }
  const token = await issueSession(sql, profile.id);
  const publicProfile = { id: profile.id, role: profile.role, displayName: profile.displayName, contact: profile.contact, registered: true, telegramLinked: Boolean(telegram || profile.telegramUserId) };
  await enqueueRemindersQuietly(profile.id);
  return send(res, 200, { profile: publicProfile, ...(await snapshot(publicProfile)) }, { 'Set-Cookie': cookie(token) });
}

async function enqueueRemindersQuietly(profileId) {
  try {
    return await enqueueProfileReminders(profileId, { maxOccurrencesPerTask: 1 });
  } catch (error) {
    console.error('telegram reminder sync failed', error instanceof Error ? error.message : 'unknown error');
    return { eligible: false, planned: 0, queued: 0, existing: 0, failed: 1 };
  }
}

async function saveState(req, res, profile) {
  if (profile.role !== 'participant') return send(res, 403, { error: 'Только участник может менять маршрут' });
  const input = await readJson(req);
  if (!input.state || typeof input.state !== 'object' || Array.isArray(input.state)) return send(res, 400, { error: 'Нет данных маршрута' });
  const packed = JSON.stringify(input.state);
  if (packed.length > 180_000) return send(res, 413, { error: 'Слишком большой маршрут' });
  const sql = getDb();
  await sql`INSERT INTO participant_state (participant_id, state_json, updated_at)
    VALUES (${profile.id}, ${packed}, NOW())
    ON CONFLICT (participant_id) DO UPDATE SET state_json = EXCLUDED.state_json, updated_at = NOW()`;
  return send(res, 200, { ok: true, reminders: await enqueueRemindersQuietly(profile.id) });
}

async function savePersonalState(req, res, profile) {
  if (profile.role !== 'mentor') return send(res, 403, { error: 'Личный маршрут наставника доступен только наставнику' });
  const input = await readJson(req);
  if (!input.state || typeof input.state !== 'object' || Array.isArray(input.state)) return send(res, 400, { error: 'Нет данных личного маршрута' });
  const packed = JSON.stringify(input.state);
  if (packed.length > 180_000) return send(res, 413, { error: 'Слишком большой маршрут' });
  const sql = getDb();
  await sql`INSERT INTO personal_states (profile_id, state_json, updated_at)
    VALUES (${profile.id}, ${packed}, NOW())
    ON CONFLICT (profile_id) DO UPDATE SET state_json = EXCLUDED.state_json, updated_at = NOW()`;
  return send(res, 200, { ok: true, reminders: await enqueueRemindersQuietly(profile.id) });
}

async function addMessage(req, res, profile) {
  const input = await readJson(req);
  const text = cleanText(input.text);
  if (!text) return send(res, 400, { error: 'Напиши сообщение' });
  const sql = getDb();
  const participantId = profile.role === 'participant' ? profile.id : cleanText(input.participantId, 80);
  if (!participantId) return send(res, 400, { error: 'Выбери участника для сообщения' });
  const targets = await sql`SELECT id FROM profiles WHERE id = ${participantId} AND role = 'participant'`;
  if (!targets[0]) return send(res, 404, { error: 'Участник не найден' });
  await sql`INSERT INTO mentor_messages (id, author_id, participant_id, body)
    VALUES (${crypto.randomUUID()}, ${profile.id}, ${participantId}, ${text})`;
  return send(res, 200, { ok: true });
}

async function submitResult(req, res, profile) {
  if (profile.role !== 'participant') return send(res, 403, { error: 'Результат отправляет участник' });
  const input = await readJson(req);
  const allowedAreas = new Set(['health', 'sport', 'biz', 'life', 'relations']);
  const areaId = allowedAreas.has(input.areaId) ? input.areaId : '';
  const value = Number(input.value);
  const unit = cleanText(input.unit, 24);
  const evidence = cleanText(input.evidence, 500);
  const proofName = cleanText(input.proofName, 120);
  const proofType = cleanText(input.proofType, 40);
  const proofData = typeof input.proofData === 'string' ? input.proofData : '';
  const validImage = !proofData || /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(proofData);
  if (!areaId) return send(res, 400, { error: 'Не выбрано направление результата' });
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000_000) return send(res, 400, { error: 'Некорректное значение результата' });
  if (!evidence && !proofData) return send(res, 400, { error: 'Добавь скриншот, ссылку или комментарий' });
  if (!validImage || proofData.length > 650_000) return send(res, 413, { error: 'Скриншот слишком большой или имеет неподдерживаемый формат' });
  if (proofData && (!proofName || proofType !== 'image/jpeg')) return send(res, 400, { error: 'Некорректные данные скриншота' });
  const id = crypto.randomUUID();
  const sql = getDb();
  await sql`UPDATE result_submissions
    SET status = 'needs_clarification', review_comment = 'Заменено новой версией результата', reviewed_at = NOW()
    WHERE participant_id = ${profile.id} AND area_id = ${areaId} AND status = 'pending'`;
  await sql`INSERT INTO result_submissions
    (id, participant_id, area_id, value, unit, evidence_text, proof_name, proof_type, proof_data)
    VALUES (${id}, ${profile.id}, ${areaId}, ${value}, ${unit}, ${evidence}, ${proofName}, ${proofType}, ${proofData})`;
  return send(res, 201, { id });
}

async function reviewResult(req, res, profile) {
  if (profile.role !== 'mentor') return send(res, 403, { error: 'Только наставник может проверять результат' });
  const input = await readJson(req);
  const status = input.status === 'approved' || input.status === 'needs_clarification' ? input.status : '';
  const comment = cleanText(input.comment);
  if (!status || !comment) return send(res, 400, { error: 'Укажи решение и комментарий' });
  const sql = getDb();
  const submissionId = cleanText(input.submissionId, 80);
  const submissions = submissionId
    ? await sql`SELECT id, participant_id AS "participantId", area_id AS "areaId", value FROM result_submissions
        WHERE id = ${submissionId} AND status IN ('pending', 'needs_clarification')`
    : await sql`SELECT id, participant_id AS "participantId", area_id AS "areaId", value FROM result_submissions
        WHERE participant_id = ${cleanText(input.participantId, 80)} AND status IN ('pending', 'needs_clarification')
        ORDER BY created_at DESC LIMIT 1`;
  const submission = submissions[0] || null;
  if (submissionId && !submission) return send(res, 404, { error: 'Заявка на проверку не найдена или уже обработана' });
  const participantId = submission?.participantId || cleanText(input.participantId, 80);
  if (!participantId) return send(res, 400, { error: 'Выбери участника' });
  const targets = await sql`SELECT id FROM profiles WHERE id = ${participantId} AND role = 'participant'`;
  if (!targets[0]) return send(res, 404, { error: 'Участник не найден' });
  if (submission) {
    await sql`UPDATE result_submissions SET status = ${status}, reviewer_id = ${profile.id},
      review_comment = ${comment}, reviewed_at = NOW() WHERE id = ${submission.id}`;
  }
  await sql`INSERT INTO result_reviews (id, reviewer_id, participant_id, status, comment)
    VALUES (${crypto.randomUUID()}, ${profile.id}, ${participantId}, ${status}, ${comment})`;
  const stateRows = await sql`SELECT state_json AS "stateJson" FROM participant_state WHERE participant_id = ${participantId}`;
  if (stateRows[0]) {
    try {
      const state = JSON.parse(stateRows[0].stateJson);
      const areaId = submission?.areaId || cleanText(input.areaId, 40);
      const primaryId = Array.isArray(state?.diagnosticAreas) ? state.diagnosticAreas[0] : '';
      const targetGoal = areaId && state?.goalsByArea?.[areaId] ? state.goalsByArea[areaId] : state?.goal;
      const pending = targetGoal?.pending;
      if (pending && targetGoal) {
        if (status === 'approved') {
          const approvedValue = Number(submission?.value ?? pending.value);
          targetGoal.current = Number.isFinite(approvedValue) ? approvedValue : (targetGoal.current || 0);
          delete targetGoal.pending;
        } else {
          targetGoal.pending = { ...pending, reviewStatus: status, reviewComment: comment };
        }
        if (areaId && state.goalsByArea) state.goalsByArea[areaId] = targetGoal;
        if (!areaId || areaId === primaryId) state.goal = targetGoal;
        await sql`UPDATE participant_state SET state_json = ${JSON.stringify(state)}, updated_at = NOW()
          WHERE participant_id = ${participantId}`;
      }
    } catch { /* malformed client state is left untouched */ }
  }
  return send(res, 200, { ok: true });
}

async function leaveMentorFeedback(req, res, profile) {
  if (profile.role !== 'participant') return send(res, 403, { error: 'Отзыв может оставить только участник' });
  const input = await readJson(req);
  const rating = Number(input.rating);
  const review = cleanText(input.review, 700);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return send(res, 400, { error: 'Поставь оценку от 1 до 5' });
  if (review.length < 8) return send(res, 400, { error: 'Напиши отзыв минимум из 8 символов' });
  const sql = getDb();
  const exists = await sql`SELECT participant_id FROM mentor_feedback WHERE participant_id = ${profile.id} AND mentor_id = 'sasha'`;
  if (exists[0]) return send(res, 409, { error: 'Отзыв уже оставлен и не редактируется в пилоте' });
  await sql`INSERT INTO mentor_feedback (participant_id, mentor_id, rating, review) VALUES (${profile.id}, 'sasha', ${rating}, ${review})`;
  return send(res, 201, { ok: true });
}

async function logout(req, res) {
  const token = parseCookie(req.headers.cookie)[COOKIE_NAME];
  if (token) {
    const sql = getDb();
    await sql`DELETE FROM sessions WHERE token = ${token}`;
  }
  return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
}

async function deleteOwnProfile(req, res, profile) {
  if (profile.role !== 'participant') return send(res, 403, { error: 'Кабинет наставника удаляется только администратором' });
  const input = await readJson(req);
  if (input.confirm !== 'delete_profile') return send(res, 400, { error: 'Удаление профиля не подтверждено' });
  const sql = getDb();
  await sql`DELETE FROM profiles WHERE id = ${profile.id} AND role = 'participant'`;
  return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
}

function telegramAppUrl() {
  const value = cleanText(process.env.WAY_APP_URL, 300);
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/i.test(value)) return '';
  return value.replace(/\/+$/, '');
}

async function telegramApi(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Telegram-бот ещё не подключён');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) throw new Error('Telegram не принял запрос');
  return data.result;
}

async function telegramWebhook(req, res) {
  const supplied = Array.isArray(req.headers['x-telegram-bot-api-secret-token'])
    ? req.headers['x-telegram-bot-api-secret-token'][0]
    : req.headers['x-telegram-bot-api-secret-token'];
  if (!isSameSecret(supplied, process.env.TELEGRAM_WEBHOOK_SECRET)) {
    return send(res, 401, { error: 'Неверная подпись Telegram' });
  }
  const update = await readJson(req);
  const message = update?.message;
  const chatId = message?.chat?.id;
  const text = cleanText(message?.text, 120).toLowerCase().split(/\s+/)[0];
  if (chatId && ['/start', '/app', '/help'].includes(text.split('@')[0])) {
    const appUrl = telegramAppUrl();
    if (!appUrl) return send(res, 503, { error: 'Адрес приложения не настроен' });
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text: 'WAY — твой путь, твои правила, твой результат. Открой приложение, чтобы увидеть цели, расписание и прогресс.',
      reply_markup: { inline_keyboard: [[{ text: 'Открыть WAY', web_app: { url: appUrl } }]] }
    });
  }
  return send(res, 200, { ok: true });
}

export default async function handler(req, res) {
  // On Vercel catch-all functions `req.query.path` differs between local dev
  // and production. The URL is the stable source of the requested API path.
  const requestUrl = new URL(req.url || '/', 'https://moy-put.local');
  const pathname = requestUrl.pathname;
  const route = pathname === '/api' ? '/' : pathname.replace(/^\/api(?=\/|$)/, '');
  try {
    if (req.method === 'GET' && route === '/telegram/health') {
      return send(res, 200, { ok: true, configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_WEBHOOK_SECRET && telegramAppUrl()) });
    }
    if (req.method === 'POST' && route === '/telegram/webhook') return await telegramWebhook(req, res);
    await ensureSchema();
    if (req.method === 'GET' && route === '/health') return send(res, 200, { ok: true, storage: 'neon-postgres' });
    if (req.method === 'POST' && route === '/register') return await register(req, res);
    if (req.method === 'POST' && route === '/resume') return await resume(req, res);
    if (req.method === 'POST' && route === '/login') return await login(req, res);
    if (req.method === 'POST' && route === '/logout') return await logout(req, res);
    const profile = await currentProfile(req);
    if (!profile) return send(res, 401, { error: 'Нужен вход' });
    if (req.method === 'GET' && route === '/snapshot') {
      return send(res, 200, { profile, ...(await snapshot(profile, cleanText(requestUrl.searchParams.get('participantId'), 80))) });
    }
    if (req.method === 'PUT' && route === '/state') return await saveState(req, res, profile);
    if (req.method === 'PUT' && route === '/personal-state') return await savePersonalState(req, res, profile);
    if (req.method === 'DELETE' && route === '/profile') return await deleteOwnProfile(req, res, profile);
    if (req.method === 'POST' && route === '/messages') return await addMessage(req, res, profile);
    if (req.method === 'POST' && route === '/result-submissions') return await submitResult(req, res, profile);
    if (req.method === 'POST' && route === '/reviews') return await reviewResult(req, res, profile);
    if (req.method === 'POST' && route === '/mentor-feedback') return await leaveMentorFeedback(req, res, profile);
    return send(res, 404, { error: 'Маршрут не найден' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ошибка сервера';
    const status = message === 'База данных ещё не подключена' ? 503 : 500;
    return send(res, status, { error: message });
  }
}
