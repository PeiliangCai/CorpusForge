/** Focused final-build validation: native reconciliation and each terminal finalization state. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), origin = 'http://127.0.0.1:30154', backend = 'http://127.0.0.1:3215';
const terminalState = process.env.T1_FINALIZING_STATE; assert.ok(['completed', 'partial'].includes(terminalState));
const directory = join(code, `runtime-data/sidebar-reconciling-${terminalState}-20261113`);
const runtime = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8')), ids = runtime.runs;
const evidence = join(code, 'docs/acceptance/sidebar-task-actions-2026-11-13'), report = JSON.parse(await readFile(join(evidence, 'report.json'), 'utf8'));
const expectedBuild = (await readFile(join(code, report.dist, 'BUILD_ID'), 'utf8')).trim();
const db = new DatabaseSync(join(directory, 't1.sqlite'), { readOnly: true });
const raw = id => db.prepare('SELECT state FROM s4_runs WHERE id=?').get(id).state;
const result = { terminal_state: terminalState, BUILD_ID: expectedBuild, checks: [], requests: [], errors: [], blocked: [], paid_model_calls: 0, production_write_requests: 0 };
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const mobile = terminalState === 'partial';
const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce', hasTouch: true });
await context.addInitScript(expected => { if (location.origin !== expected) return; localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); }, origin);
await context.route(/^https?:\/\//, async route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
  if (url.origin !== origin) { result.blocked.push({ path, method }); return route.abort('blockedbyclient'); }
  if (!path.startsWith('/api/t1/')) return route.continue();
  if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': isolated reconciliation\n\n' });
  const cancel = method === 'POST' && /\/workbench\/runs\/[^/]+\/cancel$/.test(path);
  if (!['GET', 'HEAD'].includes(method) && !cancel) { result.blocked.push({ path, method }); return route.abort('blockedbyclient'); }
  const response = await fetch(backend + path.replace(/^\/api\/t1/, '/api') + url.search, { method,
    ...(cancel ? { headers: { 'content-type': 'application/json' }, body: request.postDataBuffer() } : {}) });
  const body = Buffer.from(await response.arrayBuffer());
  if (cancel) result.requests.push({ run_id: decodeURIComponent(path.split('/').at(-2)), response_state: JSON.parse(body).run.state, raw_state: raw(decodeURIComponent(path.split('/').at(-2))) });
  return route.fulfill({ status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }, body });
});
const page = await context.newPage(); page.on('pageerror', error => result.errors.push(String(error)));
const json = async path => { const response = await fetch(backend + '/api/workbench/' + path); assert.equal(response.status, 200); return response.json(); };
const opener = id => page.locator(`.t1-paper-row:has([data-paper-id="${id}"]) .t1-paper-actions`), action = id => page.locator(`[data-cancel-run-id="${id}"]`), notice = () => page.locator('.t1-task-toast');
const snapshot = () => page.evaluate(() => ({ url: location.href, record: document.querySelector('.t1-evidence-card')?.getAttribute('data-record-id'), text: document.querySelector('.t1-quote-frame')?.textContent, query: document.querySelector('.t1-record-search input')?.value }));
const check = async (name, work) => { await work(); result.checks.push(name); console.log('PASS ' + terminalState + ': ' + name); };
try {
  assert.equal((await json('capabilities')).controlled_fixture, true); assert.equal(raw(ids.native), 'reconciling'); assert.equal(raw(ids.finalizing), terminalState);
  const nativeBefore = await json('runs/' + ids.native); assert.ok(nativeBefore.output.records.length > 0); assert.equal(nativeBefore.run.state, 'reconciling');
  await page.goto(origin + '/?' + new URLSearchParams({ paper: 'L01', run: ids.saved, view: 'records' })); await page.locator('.t1-evidence-card').waitFor(); await page.evaluate(() => document.fonts.ready);
  assert.equal((await context.request.get(origin + '/_next/static/' + expectedBuild + '/_buildManifest.js')).status(), 200);
  await page.locator('.t1-record-search input').fill((await json('runs/' + ids.saved)).output.records[0].fragments[0].exact_quote.slice(0, 8));
  if (mobile) { await page.locator('.t1-sidebar').waitFor({ state: 'detached' }); await page.getByRole('button', { name: '切换论文导航', exact: true }).click(); }
  const before = await snapshot();
  await check('terminal_finalization_is_an_actionable_candidate_but_backend_preserves_terminal_state', async () => {
    await opener('L02').click(); await action(ids.finalizing).filter({ hasText: '汇总核验中' }).waitFor(); await action(ids.finalizing).click();
    await notice().filter({ hasText: '任务正在收尾，未取消' }).waitFor(); assert.ok(!(await notice().textContent()).includes('已取消此任务'));
    assert.equal(raw(ids.finalizing), terminalState); assert.equal((await json('runs')).runs.find(run => run.run_id === ids.finalizing).state, 'reconciling'); assert.deepEqual(await snapshot(), before);
    assert.deepEqual(result.requests[0], { run_id: ids.finalizing, response_state: 'reconciling', raw_state: terminalState });
    await notice().getByRole('button', { name: '关闭', exact: true }).click();
  });
  await check('native_reconciling_can_be_cancelled_from_menu_and_saved_candidates_are_preserved', async () => {
    await opener('L01').click(); await action(ids.native).filter({ hasText: '汇总核验中' }).waitFor();
    await page.screenshot({ path: join(evidence, `native-reconciling-menu-${terminalState}-${mobile ? 'mobile' : 'desktop'}.png`) });
    await action(ids.native).click(); await notice().filter({ hasText: '已取消此任务，已有结果已保留' }).waitFor();
    const after = await json('runs/' + ids.native); assert.equal(raw(ids.native), 'cancelled'); assert.equal(after.run.state, 'cancelled');
    assert.equal(after.output.records.length, nativeBefore.output.records.length); assert.deepEqual(after.output.records, nativeBefore.output.records); assert.deepEqual(await snapshot(), before);
    result.preserved_candidate_count = after.output.records.length;
    assert.deepEqual(result.requests[1], { run_id: ids.native, response_state: 'cancelled', raw_state: 'cancelled' });
    await page.screenshot({ path: join(evidence, `native-reconciling-cancelled-${terminalState}-${mobile ? 'mobile' : 'desktop'}.png`) });
    await opener('L01').click(); assert.equal(await action(ids.native).count(), 0);
  });
  assert.deepEqual(result.errors, []); assert.deepEqual(result.blocked, []); result.status = 'passed';
} catch (cause) { result.status = 'failed'; result.failure = String(cause?.stack ?? cause); await page.screenshot({ path: join(evidence, `reconciling-failure-${terminalState}.png`) }).catch(() => {}); throw cause; }
finally {
  report.reconciling_validation ??= { cases: [] }; report.reconciling_validation.cases = report.reconciling_validation.cases.filter(item => item.terminal_state !== terminalState); report.reconciling_validation.cases.push(result);
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n'); db.close(); await browser.close();
}
