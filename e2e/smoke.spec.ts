import { test, expect } from '@playwright/test';

test('abre, simula exemplos e salva no IndexedDB', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__protobench?.ready);
  // exemplo LED abre sem erros de verificação
  const issues = await page.evaluate(() => (window as any).__protobench.AN.issues.filter((i: any) => i.sev === 'err').length);
  expect(issues).toBe(0);
  await expect(page.locator('#board')).toBeVisible();
  // edita o nome → cria projeto salvo
  await page.fill('#projName', 'Teste E2E');
  await page.press('#projName', 'Enter');
  await page.waitForFunction(() => (window as any).__protobench.Store.index().some((m: any) => m.name === 'Teste E2E'), null, { timeout: 5000 });
  // recarrega e reabre o último projeto
  await page.reload();
  await page.waitForFunction(() => (window as any).__protobench?.ready);
  await expect(page.locator('#projName')).toHaveValue('Teste E2E');
  expect(errors).toEqual([]);
});

test('manifesto e service worker do PWA', async ({ page, request }) => {
  const r = await request.get('/manifest.webmanifest');
  expect(r.ok()).toBeTruthy();
  expect((await r.json()).name).toBe('ProtoBench');
  await page.goto('/');
  const sw = await page.evaluate(async () => !!(await navigator.serviceWorker.ready));
  expect(sw).toBe(true);
});

test('funciona offline depois da primeira visita', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload(); // página passa a ser controlada pelo SW
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => (window as any).__protobench?.ready);
  await expect(page.locator('#board')).toBeVisible();
  await page.screenshot({ path: 'test-results/offline.png' });
});
