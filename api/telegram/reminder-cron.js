import crypto from 'node:crypto';
import { enqueueAllProfileReminders } from '../../lib/reminders.js';

function sameSecret(value, expected) {
  if (!expected || typeof value !== 'string') return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function reply(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { error: 'Метод не поддерживается' });
  const authorization = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  const manualSecret = Array.isArray(req.headers['x-way-cron-secret']) ? req.headers['x-way-cron-secret'][0] : req.headers['x-way-cron-secret'];
  const expected = process.env.CRON_SECRET || '';
  if (!sameSecret(authorization, `Bearer ${expected}`) && !sameSecret(manualSecret, expected)) {
    return reply(res, 401, { error: 'Неверная подпись планировщика' });
  }
  try {
    const requestUrl = new URL(req.url || '/', 'https://moy-put.local');
    const result = await enqueueAllProfileReminders({ dryRun: requestUrl.searchParams.get('dryRun') === '1' });
    return reply(res, 200, { ok: true, ...result });
  } catch (error) {
    console.error('telegram reminder cron failed', error instanceof Error ? error.message : 'unknown error');
    return reply(res, 500, { error: 'Не удалось восстановить очередь напоминаний' });
  }
}
