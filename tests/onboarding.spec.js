import { test, expect } from '@playwright/test';

function profile() {
  return { id: 'p_qa_onboarding', role: 'participant', displayName: 'Тест', contact: '@qa', registered: true };
}

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
  await expect(page.locator('#homeSpheres button')).toHaveCount(2);
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
  await expect(page.locator('#homeSpheres button')).toHaveCount(3);
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

  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('button', { name: 'Расписание: Завтра · 20:00' })).toBeVisible();
  await page.waitForTimeout(650);
  expect(state.schedules['health::Сон до 23:30']).toEqual({ date: expectedTomorrow, time: '20:00', repeat: 'none' });
});
