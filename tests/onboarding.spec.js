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
