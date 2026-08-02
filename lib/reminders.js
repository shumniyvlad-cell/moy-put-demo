import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { send as sendQueueMessage } from '@vercel/queue';

export const REMINDER_TOPIC = 'way-telegram-reminders';
export const MAX_QUEUE_DELAY_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_TIME_ZONE = 'Europe/Moscow';
const AREA_NAMES = {
  health: 'Здоровье и энергия',
  sport: 'Спорт и тело',
  biz: 'Доход и дело',
  life: 'Смысл и развитие',
  relations: 'Отношения и окружение'
};

let reminderSchemaReady = null;

function reminderDb() {
  if (!process.env.DATABASE_URL) throw new Error('База данных ещё не подключена');
  return neon(process.env.DATABASE_URL);
}

function parseState(value) {
  try { return value ? JSON.parse(value) : null; }
  catch { return null; }
}

function clean(value, max = 700) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function normalizeTimeZone(value) {
  const candidate = clean(value, 80) || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

export function normalizeReminderSchedule(value, stateTimeZone = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value.date || '') ? value.date : '';
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(value.time || '') ? value.time : '';
  if (!date || !time) return null;
  const repeat = ['none', 'daily', 'weekdays', 'weekly'].includes(value.repeat) ? value.repeat : 'none';
  return {
    date,
    time,
    repeat,
    timezone: normalizeTimeZone(value.timezone || stateTimeZone),
    notifyTelegram: value.notifyTelegram !== false
  };
}

function datePartsInZone(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(value).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
    return result;
  }, {});
  return parts;
}

export function dateKeyInZone(value, timeZone) {
  const parts = datePartsInZone(value, normalizeTimeZone(timeZone));
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function localDateTimeToUtc(dateKey, time, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '')) return null;
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const zone = normalizeTimeZone(timeZone);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = target;
  for (let pass = 0; pass < 4; pass += 1) {
    const rendered = datePartsInZone(new Date(guess), zone);
    const renderedUtc = Date.UTC(rendered.year, rendered.month - 1, rendered.day, rendered.hour, rendered.minute, rendered.second || 0, 0);
    const corrected = target - (renderedUtc - guess);
    if (Math.abs(corrected - guess) < 1000) {
      guess = corrected;
      break;
    }
    guess = corrected;
  }
  return new Date(guess);
}

function addDays(dateKey, count) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + count));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

function weekday(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function scheduleApplies(schedule, dateKey) {
  if (dateKey < schedule.date) return false;
  if (schedule.repeat === 'none') return dateKey === schedule.date;
  if (schedule.repeat === 'daily') return true;
  if (schedule.repeat === 'weekdays') return weekday(dateKey) > 0 && weekday(dateKey) < 6;
  if (schedule.repeat === 'weekly') return weekday(dateKey) === weekday(schedule.date);
  return false;
}

function splitTaskKey(taskKey) {
  const at = String(taskKey || '').indexOf('::');
  if (at <= 0) return null;
  return { areaId: taskKey.slice(0, at), text: taskKey.slice(at + 2) };
}

export function reminderScheduleFingerprint(schedule) {
  const normalized = normalizeReminderSchedule(schedule, schedule?.timezone);
  return normalized ? digest(JSON.stringify(normalized)) : '';
}

function taskStillExists(state, taskKey) {
  const task = splitTaskKey(taskKey);
  return Boolean(task && Array.isArray(state?.actionsByArea?.[task.areaId]) && state.actionsByArea[task.areaId].includes(task.text));
}

export function buildReminderOccurrences(profileId, state, options = {}) {
  if (!profileId || !state || typeof state !== 'object') return [];
  const now = options.now instanceof Date ? options.now : new Date();
  const horizon = options.horizon instanceof Date
    ? options.horizon
    : new Date(now.getTime() + MAX_QUEUE_DELAY_SECONDS * 1000 - 60_000);
  const maxPerTask = Number.isFinite(options.maxOccurrencesPerTask) ? Math.max(1, options.maxOccurrencesPerTask) : Number.POSITIVE_INFINITY;
  const schedules = state.schedules && typeof state.schedules === 'object' && !Array.isArray(state.schedules) ? state.schedules : {};
  const occurrences = [];

  Object.entries(schedules).forEach(([taskKey, rawSchedule]) => {
    if (!taskStillExists(state, taskKey)) return;
    const schedule = normalizeReminderSchedule(rawSchedule, state.timezone);
    if (!schedule || !schedule.notifyTelegram) return;
    const task = splitTaskKey(taskKey);
    const fingerprint = reminderScheduleFingerprint(schedule);
    let dateKey = dateKeyInZone(now, schedule.timezone);
    const lastDateKey = dateKeyInZone(horizon, schedule.timezone);
    let added = 0;
    for (let guard = 0; guard < 9 && dateKey <= lastDateKey && added < maxPerTask; guard += 1, dateKey = addDays(dateKey, 1)) {
      if (!scheduleApplies(schedule, dateKey)) continue;
      const dueAt = localDateTimeToUtc(dateKey, schedule.time, schedule.timezone);
      if (!dueAt || dueAt.getTime() < now.getTime() || dueAt.getTime() > horizon.getTime()) continue;
      const done = Array.isArray(state?.days?.[dateKey]?.done) ? state.days[dateKey].done : [];
      if (done.includes(taskKey)) continue;
      const dueIso = dueAt.toISOString();
      const idempotencyKey = digest(`${profileId}\n${taskKey}\n${dueIso}\n${fingerprint}`);
      occurrences.push({
        idempotencyKey,
        profileId,
        taskKey,
        areaId: task.areaId,
        areaName: AREA_NAMES[task.areaId] || 'Твоя цель',
        text: task.text,
        dateKey,
        dueAt: dueIso,
        timezone: schedule.timezone,
        scheduleFingerprint: fingerprint
      });
      added += 1;
    }
  });

  return occurrences.sort((left, right) => left.dueAt.localeCompare(right.dueAt));
}

export function reminderIsCurrent(state, message) {
  if (!state || !message || !taskStillExists(state, message.taskKey)) return false;
  const schedule = normalizeReminderSchedule(state.schedules?.[message.taskKey], state.timezone);
  if (!schedule || !schedule.notifyTelegram) return false;
  if (reminderScheduleFingerprint(schedule) !== message.scheduleFingerprint) return false;
  if (!scheduleApplies(schedule, message.dateKey)) return false;
  const expected = localDateTimeToUtc(message.dateKey, schedule.time, schedule.timezone);
  if (!expected || expected.toISOString() !== message.dueAt) return false;
  const done = Array.isArray(state?.days?.[message.dateKey]?.done) ? state.days[message.dateKey].done : [];
  return !done.includes(message.taskKey);
}

export async function ensureReminderSchema(sql = reminderDb()) {
  if (!reminderSchemaReady) {
    reminderSchemaReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS telegram_reminders (
        idempotency_key TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        task_key TEXT NOT NULL,
        task_text TEXT NOT NULL,
        due_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'sending', 'sent', 'skipped')),
        queue_message_id TEXT,
        sent_at TIMESTAMPTZ,
        skip_reason TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS telegram_reminders_due_idx ON telegram_reminders (due_at, status)`;
      return true;
    })().catch((error) => {
      reminderSchemaReady = null;
      throw error;
    });
  }
  return reminderSchemaReady;
}

async function reminderProfiles(sql, profileId = '') {
  const rows = profileId
    ? await sql`SELECT p.id, p.role, p.telegram_user_id AS "telegramUserId",
        CASE WHEN p.role = 'mentor' THEN personal.state_json ELSE participant.state_json END AS "stateJson"
        FROM profiles p
        LEFT JOIN participant_state participant ON participant.participant_id = p.id
        LEFT JOIN personal_states personal ON personal.profile_id = p.id
        WHERE p.id = ${profileId}`
    : await sql`SELECT p.id, p.role, p.telegram_user_id AS "telegramUserId",
        CASE WHEN p.role = 'mentor' THEN personal.state_json ELSE participant.state_json END AS "stateJson"
        FROM profiles p
        LEFT JOIN participant_state participant ON participant.participant_id = p.id
        LEFT JOIN personal_states personal ON personal.profile_id = p.id
        WHERE p.telegram_user_id IS NOT NULL
          AND ((p.role = 'participant' AND participant.state_json IS NOT NULL)
            OR (p.role = 'mentor' AND personal.state_json IS NOT NULL))`;
  return rows.map((row) => ({ ...row, state: parseState(row.stateJson) })).filter((row) => row.state);
}

async function enqueueOccurrences(sql, occurrences, now) {
  const result = { planned: occurrences.length, queued: 0, existing: 0, failed: 0 };
  await ensureReminderSchema(sql);
  for (const occurrence of occurrences) {
    const inserted = await sql`INSERT INTO telegram_reminders
      (idempotency_key, profile_id, task_key, task_text, due_at)
      VALUES (${occurrence.idempotencyKey}, ${occurrence.profileId}, ${occurrence.taskKey}, ${occurrence.text}, ${occurrence.dueAt})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING idempotency_key`;
    if (!inserted[0]) {
      result.existing += 1;
      continue;
    }
    const delaySeconds = Math.max(0, Math.ceil((new Date(occurrence.dueAt).getTime() - now.getTime()) / 1000));
    try {
      const queued = await sendQueueMessage(REMINDER_TOPIC, occurrence, {
        delaySeconds,
        retentionSeconds: MAX_QUEUE_DELAY_SECONDS,
        idempotencyKey: occurrence.idempotencyKey
      });
      await sql`UPDATE telegram_reminders SET queue_message_id = ${queued.messageId || null}, updated_at = NOW()
        WHERE idempotency_key = ${occurrence.idempotencyKey}`;
      result.queued += 1;
    } catch (error) {
      await sql`DELETE FROM telegram_reminders WHERE idempotency_key = ${occurrence.idempotencyKey} AND status = 'planned'`;
      result.failed += 1;
      console.error('telegram reminder enqueue failed', error instanceof Error ? error.message : 'unknown error');
    }
  }
  return result;
}

export async function enqueueProfileReminders(profileId, options = {}) {
  const sql = reminderDb();
  const now = options.now instanceof Date ? options.now : new Date();
  const rows = await reminderProfiles(sql, profileId);
  const profile = rows[0];
  if (!profile?.telegramUserId) return { eligible: false, planned: 0, queued: 0, existing: 0, failed: 0 };
  const occurrences = buildReminderOccurrences(profile.id, profile.state, {
    now,
    maxOccurrencesPerTask: options.maxOccurrencesPerTask || 1
  });
  if (options.dryRun) return { eligible: true, planned: occurrences.length, queued: 0, existing: 0, failed: 0 };
  return { eligible: true, ...(await enqueueOccurrences(sql, occurrences, now)) };
}

export async function enqueueAllProfileReminders(options = {}) {
  const sql = reminderDb();
  const now = options.now instanceof Date ? options.now : new Date();
  const profiles = await reminderProfiles(sql);
  const occurrences = profiles.flatMap((profile) => buildReminderOccurrences(profile.id, profile.state, { now }));
  if (options.dryRun) return { profiles: profiles.length, planned: occurrences.length, queued: 0, existing: 0, failed: 0 };
  return { profiles: profiles.length, ...(await enqueueOccurrences(sql, occurrences, now)) };
}

function telegramAppUrl() {
  const value = clean(process.env.WAY_APP_URL, 300);
  return /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/i.test(value) ? value.replace(/\/+$/, '') : '';
}

async function markSkipped(sql, idempotencyKey, reason) {
  await sql`UPDATE telegram_reminders SET status = 'skipped', skip_reason = ${clean(reason, 160)}, updated_at = NOW()
    WHERE idempotency_key = ${idempotencyKey}`;
}

async function sendTelegramReminder(chatId, message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const appUrl = telegramAppUrl();
  if (!token || !appUrl) throw new Error('Telegram reminders are not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `⏰ Пора действовать\n\n${message.text}\n\n${message.areaName}\nОтметь выполнение в WAY.`,
      reply_markup: { inline_keyboard: [[{ text: 'Открыть WAY', web_app: { url: appUrl } }]] }
    })
  });
  const data = await response.json().catch(() => null);
  if (response.ok && data?.ok) return;
  const error = new Error('Telegram не принял напоминание');
  error.permanent = response.status === 400 || response.status === 403;
  throw error;
}

export async function processReminderMessage(message) {
  if (!message || typeof message !== 'object' || !/^[a-f0-9]{64}$/.test(message.idempotencyKey || '')) return { status: 'invalid' };
  const sql = reminderDb();
  await ensureReminderSchema(sql);
  const claimed = await sql`UPDATE telegram_reminders SET status = 'sending', updated_at = NOW()
    WHERE idempotency_key = ${message.idempotencyKey}
      AND (status = 'planned' OR (status = 'sending' AND updated_at < NOW() - INTERVAL '5 minutes'))
    RETURNING idempotency_key`;
  if (!claimed[0]) return { status: 'already-processed' };

  try {
    const rows = await reminderProfiles(sql, clean(message.profileId, 100));
    const profile = rows[0];
    if (!profile?.state || !reminderIsCurrent(profile.state, message)) {
      await markSkipped(sql, message.idempotencyKey, 'Расписание изменено или задача уже выполнена');
      return { status: 'skipped' };
    }
    if (!profile.telegramUserId) {
      await markSkipped(sql, message.idempotencyKey, 'Telegram не привязан');
      return { status: 'skipped' };
    }
    await sendTelegramReminder(profile.telegramUserId, message);
    await sql`UPDATE telegram_reminders SET status = 'sent', sent_at = NOW(), updated_at = NOW()
      WHERE idempotency_key = ${message.idempotencyKey}`;
    return { status: 'sent' };
  } catch (error) {
    if (error?.permanent) {
      await markSkipped(sql, message.idempotencyKey, 'Telegram недоступен для пользователя');
      return { status: 'skipped' };
    }
    await sql`UPDATE telegram_reminders SET status = 'planned', updated_at = NOW()
      WHERE idempotency_key = ${message.idempotencyKey}`;
    throw error;
  }
}
