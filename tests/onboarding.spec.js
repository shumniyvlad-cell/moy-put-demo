import { test, expect } from '@playwright/test';

function profile() {
  return { id: 'p_qa_onboarding', role: 'participant', displayName: 'Тест', contact: '@qa', registered: true, telegramLinked: true };
}

function completedState() {
  return {
    v: 8,
    name: 'Тест',
    contact: '@qa',
    dir: 'health',
    dirName: 'Здоровье и энергия',
    mode: 'Сам',
    mentorId: 'alex',
    diagnosticAreas: ['health'],
    diagnosticGoals: { health: 'Спать 8 часов' },
    goalsByArea: { health: { title: 'Спать 8 часов', target: 30, current: 4, unit: 'дней', deadline: '', pending: null } },
    actionsByArea: { health: ['Лечь до 23:00'] },
    habits: ['health::Лечь до 23:00'],
    days: {},
    schedules: {},
    quoteDismissedOn: '',
    lastCheckinAt: '',
    rewards: { weeks: {}, returns: {}, shares: {} },
    bonus: 0,
    applied: false,
    mentorStatus: 'none',
    onboardingStep: 'complete',
    onboardingComplete: true,
    created: '2026-08-03'
  };
}

test('mobile app shell has no simulated iPhone status bar', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/snapshot' || path === '/api/resume') {
      return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Нужен вход"}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:8767/');
  await expect(page.locator('.screen.active')).toHaveAttribute('data-s', 'splash');
  await expect(page.locator('.notch, .statusbar')).toHaveCount(0);

  const shell = await page.locator('.phone').boundingBox();
  expect(shell).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/app-shell-without-phone-status.png' });
});

test('participant completes passwordless onboarding and stays signed in', async ({ page }) => {
  let registered = false;
  let state = null;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/register') {
      registered = true;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ profile: profile(), state: null, messages: [], resultSubmissions: [], mentorProfile: { displayName: 'Саша' } }) });
    }
    if (path === '/api/state') {
      state = request.postDataJSON().state;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    if (path === '/api/snapshot') {
      if (!registered) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Нужен вход"}' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profile: profile(), state, messages: [], resultSubmissions: [], mentorProfile: { displayName: 'Саша' } }) });
    }
    if (path === '/api/resume') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Сохранённый вход не найден"}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.goto('http://127.0.0.1:8767/');
  await expect(page.locator('.screen.active')).toHaveAttribute('data-s', 'splash');
  await page.locator('.way-splash-arrow').click();
  await expect(page.locator('.screen.active')).toHaveAttribute('data-s', 'participantregister');
  await expect(page.getByText('Пароль не нужен.')).toBeVisible();
  await expect(page.locator('[data-s="participantregister"] input[type="password"]')).toHaveCount(0);
  await page.waitForTimeout(450);

  for (const viewport of [{ width: 360, height: 800 }, { width: 430, height: 932 }, { width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await expect(page.locator('#participantRegisterButton')).toBeVisible();
    await page.screenshot({ path: `test-results/register-${viewport.width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });

  await page.locator('#participantName').fill('Тест');
  await page.locator('#participantContact').fill('@qa');
  await page.locator('#participantRegisterButton').click();
  await expect(page.locator('#toastMsg')).toContainText('согласие');
  await page.locator('#participantConsent').click();
  await page.locator('#participantRegisterButton').click();
  await expect(page.locator('.screen.active')).toHaveAttribute('data-s', 'pain');

  await page.locator('[data-area="health"] .diag-head').click();
  await page.locator('#diag-health').fill('Спать 8 часов 20 дней');
  await page.locator('[data-area="biz"] .diag-head').click();
  await page.locator('#diag-biz').fill('Получить 5 новых клиентов');
  await page.locator('[data-s="pain"] .btn-amber').click();
  await expect(page.locator('.screen.active')).toHaveAttribute('data-s', 'minimum');

  await page.locator('[data-s="minimum"] .btn-amber').click();
  await expect(page.locator('.screen.active')).toHaveAttribute('data-s', 'minimum');
  await page.locator('[data-s="minimum"] .btn-amber').click();
  await expect(page.locator('.screen.active')).toHaveAttribute('data-s', 'mentor');
  await page.locator('#modeSelf').click();
  await page.locator('[data-s="mentor"] .btn-amber').click();
  await expect(page.locator('.screen.active')).toHaveAttribute('data-s', 'today');
  await expect(page.locator('#homeSpheres button')).toHaveCount(3);
  await page.waitForTimeout(450);
  await page.screenshot({ path: 'test-results/today-light-mobile.png', fullPage: true });
  await page.locator('.theme-toggle').first().click();
  await expect(page.locator('body')).toHaveClass(/theme-way-b/);
  await page.waitForTimeout(450);
  await page.screenshot({ path: 'test-results/today-dark-mobile.png', fullPage: true });

  await page.waitForTimeout(650);
  expect(state && state.onboardingComplete).toBe(true);
  expect(state.diagnosticAreas).toEqual(['health', 'biz']);
  expect(Object.keys(state.actionsByArea)).toEqual(expect.arrayContaining(['health', 'biz']));

  await page.reload();
  await expect(page.locator('.screen.active')).toHaveAttribute('data-s', 'today');
  await expect(page.locator('#wayProfileName')).toBeAttached();
});

test('today screen centers selected areas and composes schedule presets', async ({ page }) => {
  const now = new Date();
  const currentDate = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  const previous = new Date(now); previous.setDate(previous.getDate() - 1);
  const previousDate = [previous.getFullYear(), String(previous.getMonth() + 1).padStart(2, '0'), String(previous.getDate()).padStart(2, '0')].join('-');
  let state = {
    v: 8,
    name: 'Тест',
    contact: '@qa',
    dir: 'health',
    dirName: 'Здоровье и энергия',
    mode: 'Сам',
    mentorId: 'alex',
    diagnosticAreas: ['health', 'sport', 'biz'],
    diagnosticGoals: {
      health: 'Высыпаться 5 раз',
      sport: 'Тренироваться 3 раза',
      biz: 'Сделать 10 предложений'
    },
    goalsByArea: {
      health: { title: 'Высыпаться 5 раз', target: 5, current: 0, unit: 'раз', deadline: '', pending: null },
      sport: { title: 'Тренироваться 3 раза', target: 3, current: 1, unit: 'раз', deadline: '', pending: null },
      biz: { title: 'Сделать 10 предложений', target: 10, current: 2, unit: 'предложений', deadline: '', pending: null }
    },
    actionsByArea: {
      health: ['Сон до 23:30'],
      sport: ['Тренировка'],
      biz: ['Написать 3 клиентам']
    },
    habits: ['health::Сон до 23:30', 'sport::Тренировка', 'biz::Написать 3 клиентам'],
    days: {},
    schedules: {
      'sport::Тренировка': { date: previousDate, time: '20:00', repeat: 'daily', timezone: 'Europe/Moscow', notifyTelegram: true },
      'biz::Написать 3 клиентам': { date: currentDate, time: '09:00', repeat: 'none', timezone: 'Europe/Moscow', notifyTelegram: true }
    },
    quoteDismissedOn: '',
    lastCheckinAt: '',
    rewards: { weeks: {}, returns: {}, shares: {} },
    bonus: 0,
    applied: false,
    mentorStatus: 'none',
    onboardingStep: 'complete',
    onboardingComplete: true,
    created: '2026-08-02'
  };

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/snapshot') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profile: profile(), state, messages: [], resultSubmissions: [], mentorProfile: { displayName: 'Саша' } }) });
    }
    if (path === '/api/state') {
      state = request.postDataJSON().state;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    if (path === '/api/resume') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Сохранённый вход не найден"}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:8767/#today');
  await expect(page.locator('.screen.active')).toHaveAttribute('data-s', 'today');
  const topPadding = await page.locator('.screen.active').evaluate((element) => parseFloat(getComputedStyle(element).paddingTop));
  expect(topPadding).toBe(20);
  await expect(page.locator('#homeSpheres button')).toHaveCount(4);
  await expect(page.getByText('Быстрые действия', { exact: true })).toHaveCount(0);
  await expect(page.locator('.way-quick')).toHaveCount(0);

  const centerDelta = await page.locator('#homeSpheres').evaluate((element) => {
    const buttons = [...element.querySelectorAll('button')];
    const container = element.getBoundingClientRect();
    const first = buttons[0].getBoundingClientRect();
    const last = buttons[buttons.length - 1].getBoundingClientRect();
    return ((first.left + last.right) / 2) - ((container.left + container.right) / 2);
  });
  expect(Math.abs(centerDelta)).toBeLessThan(1);
  const percentageFont = await page.locator('#homeGoalPct').evaluate((element) => getComputedStyle(element).fontFamily);
  expect(percentageFont).toContain('Inter');
  expect(percentageFont).not.toContain('Unbounded');

  await page.locator('[data-home-area="all"]').click();
  await expect(page.locator('#dayList .t')).toHaveCount(3);
  await expect(page.locator('#dayList .task-area-tag')).toHaveCount(3);
  await expect(page.locator('#dayList .task-group-today .t')).toHaveCount(1);
  await expect(page.locator('#dayList .task-group-today .task-time')).toHaveCount(0);
  await expect(page.locator('#dayList .task-group-scheduled .t')).toHaveCount(2);
  await expect(page.locator('#dayList .task-group-heading')).toContainText('Расписание');
  await expect(page.locator('#dayList .task-group-scheduled .t').nth(0)).toHaveAttribute('data-task', 'biz::Написать 3 клиентам');
  await expect(page.locator('#dayList .task-group-scheduled .t').nth(1)).toHaveAttribute('data-task', 'sport::Тренировка');
  await expect(page.locator('#homeGoalArea')).toHaveText('Все направления');
  await expect(page.locator('#homeGoalTitle')).toHaveText('0 из 3 задач выполнено');
  await page.locator('#dayList [data-task="sport::Тренировка"] .task-main').click();
  await expect(page.locator('#homeGoalTitle')).toHaveText('1 из 3 задач выполнено');
  await expect(page.locator('#dayList [data-task="sport::Тренировка"]')).toHaveClass(/done/);
  await page.screenshot({ path: 'test-results/today-all-focuses-light.png', fullPage: true });
  await page.locator('[data-home-area="health"]').click();

  await page.getByRole('button', { name: 'Расписание: Добавить время' }).click();
  const dateInput = page.locator('#scheduleDate');
  const timeInput = page.locator('#scheduleTime');
  const initialDate = await dateInput.inputValue();
  const tomorrow = new Date(`${initialDate}T12:00:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const expectedTomorrow = [tomorrow.getFullYear(), String(tomorrow.getMonth() + 1).padStart(2, '0'), String(tomorrow.getDate()).padStart(2, '0')].join('-');

  await page.locator('[data-schedule-preset="tomorrow"]').click();
  await page.locator('[data-schedule-preset="evening"]').click();
  await expect(dateInput).toHaveValue(expectedTomorrow);
  await expect(timeInput).toHaveValue('20:00');
  await expect(page.locator('[data-schedule-preset="tomorrow"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-schedule-preset="evening"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#scheduleSelected')).toHaveText('Выбрано: Завтра · 20:00');
  await expect(page.locator('#scheduleTelegram')).toBeChecked();
  await expect(page.locator('#scheduleTelegramHint')).toHaveText('Бот напишет точно в выбранное время.');
  const lightSheet = await page.locator('.schedule-sheet').boundingBox();
  expect(lightSheet).not.toBeNull();
  expect(lightSheet.x).toBeGreaterThanOrEqual(0);
  expect(lightSheet.y).toBeGreaterThanOrEqual(0);
  expect(lightSheet.x + lightSheet.width).toBeLessThanOrEqual(390);
  expect(lightSheet.y + lightSheet.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: 'test-results/schedule-telegram-light.png' });

  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('button', { name: 'Расписание: Завтра · 20:00' })).toBeVisible();
  await page.locator('.theme-toggle').first().click();
  await expect(page.locator('body')).toHaveClass(/theme-way-b/);
  await page.getByRole('button', { name: 'Расписание: Завтра · 20:00' }).click();
  await expect(page.locator('#scheduleTelegramHint')).toHaveText('Бот напишет точно в выбранное время.');
  await page.screenshot({ path: 'test-results/schedule-telegram-dark.png' });
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await page.locator('[data-home-area="all"]').click();
  await expect(page.locator('#dayList .t')).toHaveCount(2);
  await expect(page.locator('#dayList [data-task="health::Сон до 23:30"]')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/today-all-focuses-dark.png', fullPage: true });
  await page.waitForTimeout(650);
  expect(state.schedules['health::Сон до 23:30']).toMatchObject({ date: expectedTomorrow, time: '20:00', repeat: 'none', notifyTelegram: true });
  expect(state.schedules['health::Сон до 23:30'].timezone).toBeTruthy();
});

test('five selected areas and the all filter stay visible in one row', async ({ page }) => {
  const areas = ['health', 'sport', 'biz', 'life', 'relations'];
  const state = {
    v: 8, name: 'Тест', contact: '@qa', dir: 'health', dirName: 'Здоровье и энергия', mode: 'Сам', mentorId: 'alex',
    diagnosticAreas: areas,
    diagnosticGoals: Object.fromEntries(areas.map((id) => [id, `Цель ${id}`])),
    goalsByArea: Object.fromEntries(areas.map((id) => [id, { title: `Цель ${id}`, target: 10, current: 0, unit: 'шагов', deadline: '', pending: null }])),
    actionsByArea: Object.fromEntries(areas.map((id) => [id, [`Задача ${id}`]])),
    habits: areas.map((id) => `${id}::Задача ${id}`), days: {}, schedules: {}, quoteDismissedOn: '', lastCheckinAt: '',
    rewards: { weeks: {}, returns: {}, shares: {} }, bonus: 0, applied: false, mentorStatus: 'none',
    onboardingStep: 'complete', onboardingComplete: true, created: '2026-08-03'
  };

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/snapshot') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profile: profile(), state, messages: [], resultSubmissions: [], mentorProfile: { displayName: 'Саша' } }) });
    if (path === '/api/resume') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Сохранённый вход не найден"}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:8767/#today');
  await expect(page.locator('#homeSpheres')).toHaveClass(/is-dense/);
  await expect(page.locator('#homeSpheres button')).toHaveCount(6);
  const rail = await page.locator('#homeSpheres').evaluate((element) => {
    const container = element.getBoundingClientRect();
    const boxes = [...element.querySelectorAll('button')].map((button) => button.getBoundingClientRect());
    return { rows: new Set(boxes.map((box) => Math.round(box.top))).size, inside: boxes.every((box) => box.left >= container.left && box.right <= container.right) };
  });
  expect(rail).toEqual({ rows: 1, inside: true });
  await page.locator('[data-home-area="all"]').click();
  await expect(page.locator('#dayList .t')).toHaveCount(5);
  await page.screenshot({ path: 'test-results/today-six-filters-light.png', fullPage: true });
});

test('existing device is not sent to a new registration when resume fails', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('way_registered_once', '1');
    localStorage.setItem('way_device_credential', 'abcdefghijklmnopqrstuvwxyzABCDEFGH12345678');
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/snapshot') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Нужен вход"}' });
    if (path === '/api/resume') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Сохранённый вход не найден"}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.goto('http://127.0.0.1:8767/');
  await expect(page.locator('.screen.active')).toHaveAttribute('data-s', 'restoreerror');
  await expect(page.getByRole('heading', { name: 'Не удалось восстановить вход' })).toBeVisible();
  await expect(page.locator('.screen[data-s="participantregister"]')).not.toHaveClass(/active/);
});

test('state changes made during an in-flight save are sent afterwards', async ({ page }) => {
  let state = {
    v: 8,
    name: 'Тест',
    contact: '@qa',
    dir: 'health',
    dirName: 'Здоровье и энергия',
    mode: 'Сам',
    mentorId: 'alex',
    diagnosticAreas: ['health'],
    diagnosticGoals: { health: 'Спать 8 часов' },
    goalsByArea: { health: { title: 'Спать 8 часов', target: 30, current: 0, unit: 'дней', deadline: '', pending: null } },
    actionsByArea: { health: ['Лечь до 23:00'] },
    habits: ['health::Лечь до 23:00'],
    days: {},
    schedules: {},
    quoteDismissedOn: '',
    lastCheckinAt: '',
    rewards: { weeks: {}, returns: {}, shares: {} },
    bonus: 0,
    applied: false,
    mentorStatus: 'none',
    onboardingStep: 'complete',
    onboardingComplete: true,
    created: '2026-08-02'
  };
  const writes = [];

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/snapshot') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profile: profile(), state, messages: [], resultSubmissions: [], mentorProfile: { displayName: 'Саша' } }) });
    }
    if (path === '/api/state') {
      const next = request.postDataJSON().state;
      writes.push(next);
      if (writes.length === 1) await new Promise((resolve) => setTimeout(resolve, 800));
      state = next;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.goto('http://127.0.0.1:8767/#today');
  await expect(page.locator('.screen.active')).toHaveAttribute('data-s', 'today');
  await page.evaluate(() => {
    S.lifeGoal = 'Первое изменение';
    save();
  });
  await expect.poll(() => writes.length).toBe(1);
  await page.evaluate(() => {
    S.lifeGoal = 'Последнее изменение должно сохраниться';
    save();
  });
  await expect.poll(() => writes.length, { timeout: 4000 }).toBeGreaterThanOrEqual(2);
  expect(writes.at(-1).lifeGoal).toBe('Последнее изменение должно сохраниться');
});

test('Telegram profile creates a one-time Safari install link', async ({ page }) => {
  let createBody = null;
  const handoffToken = 'install_handoff_token_1234567890_ABCDEFGH';
  await page.route('https://telegram.org/js/telegram-web-app.js*', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.addInitScript(() => {
    window.__wayOpenedInstallLink = '';
    Object.defineProperty(window, 'Telegram', {
      configurable: false,
      writable: false,
      value: {
        WebApp: {
          initData: 'signed-telegram-init-data',
          ready() {},
          expand() {},
          setHeaderColor() {},
          setBackgroundColor() {},
          openLink(url) { window.__wayOpenedInstallLink = url; }
        }
      }
    });
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/snapshot') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profile: profile(), state: completedState(), messages: [], resultSubmissions: [], mentorProfile: { displayName: 'Саша' } }) });
    }
    if (path === '/api/install-handoff-create') {
      createBody = request.postDataJSON();
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ handoffToken, expiresIn: 600 }) });
    }
    if (path === '/api/device/link') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:8767/#profile');
  await expect(page.locator('.screen.active')).toHaveAttribute('data-s', 'profile');
  await expect(page.locator('#profileInstallRow')).toBeVisible();
  await expect(page.locator('#profileInstallTitle')).toHaveText('Установить WAY на iPhone');
  await page.locator('#profileInstallRow').click();
  await expect.poll(() => page.evaluate(() => window.__wayOpenedInstallLink)).toContain(`#install=${handoffToken}`);
  expect(createBody).toEqual({ telegramInitData: 'signed-telegram-init-data' });
  const opened = await page.evaluate(() => window.__wayOpenedInstallLink);
  expect(new URL(opened).search).toBe('');
});

test('Safari consumes the handoff, removes it from the URL and keeps the profile on reload', async ({ page }) => {
  const handoffToken = 'install_handoff_token_1234567890_ABCDEFGH';
  let consumeBody = null;
  let snapshotCalls = 0;
  let linkedDevice = '';
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const snapshot = { profile: profile(), state: completedState(), messages: [], resultSubmissions: [], mentorProfile: { displayName: 'Саша' } };
    if (path === '/api/install-handoff-consume') {
      consumeBody = request.postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) });
    }
    if (path === '/api/snapshot') {
      snapshotCalls += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) });
    }
    if (path === '/api/device/link') {
      linkedDevice = request.postDataJSON().deviceToken;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:8767/#install=${handoffToken}`);
  await expect(page.locator('.screen.active')).toHaveAttribute('data-s', 'today');
  await expect(page).toHaveURL('http://127.0.0.1:8767/#today');
  expect(page.url()).not.toContain('#install=');
  await expect(page.locator('#installOverlay')).toBeVisible();
  await expect(page.locator('#installGuideTitle')).toHaveText('Вход перенесён');
  const installSheet = await page.locator('.install-sheet').boundingBox();
  expect(installSheet).not.toBeNull();
  expect(installSheet.x).toBeGreaterThanOrEqual(0);
  expect(installSheet.y).toBeGreaterThanOrEqual(0);
  expect(installSheet.x + installSheet.width).toBeLessThanOrEqual(390);
  expect(installSheet.y + installSheet.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: 'test-results/install-handoff-light.png' });
  expect(consumeBody.handoffToken).toBe(handoffToken);
  expect(consumeBody.deviceToken).toMatch(/^[A-Za-z0-9_-]{32,180}$/);
  expect(snapshotCalls).toBe(0);
  const firstDevice = consumeBody.deviceToken;
  await page.getByRole('button', { name: 'Понятно' }).click();
  await page.locator('.theme-toggle').first().click();
  await page.evaluate(() => showInstallGuide(true));
  await expect(page.locator('body')).toHaveClass(/theme-way-b/);
  await page.screenshot({ path: 'test-results/install-handoff-dark.png' });
  await page.getByRole('button', { name: 'Понятно' }).click();

  await page.reload();
  await expect(page.locator('.screen.active')).toHaveAttribute('data-s', 'today');
  await expect(page.locator('#installOverlay')).toBeHidden();
  await expect.poll(() => snapshotCalls).toBe(1);
  await expect.poll(() => linkedDevice).toBe(firstDevice);
});
