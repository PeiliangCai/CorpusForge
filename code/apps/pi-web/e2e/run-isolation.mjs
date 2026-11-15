/** Exact-task boundaries against an isolated no-model workflow; never reaches production business APIs. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const origin = 'http://127.0.0.1:30157', backend = 'http://127.0.0.1:3216';
const phase = process.env.T1_ISOLATION_PHASE ?? 'after', evidence = join(code, 'docs/acceptance/new-task-layout-2026-11-14');
const runtime = JSON.parse(await readFile(join(code, 'runtime-data/agent-notes/run-isolation-runtime.json'), 'utf8'));
const result = { status: 'running', origin, isolated_backend: backend, phase, controlled: true, checks: [], errors: [], blocked: [], observations: [], paid_calls: 0, production_business_writes: 0, exports_requested: 0 };
result.dist = phase === 'before' ? 'apps/pi-web/build/remove-explicit-reuse-validated-20261114' : 'apps/pi-web/build/run-isolation-validated-20261114';
result.BUILD_ID = (await readFile(join(code, result.dist, 'BUILD_ID'), 'utf8')).trim();
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
await context.addInitScript(expected => { if (location.origin === expected) { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); } }, origin);
let holdRun = '', failRun = '', release = () => {}, requested = () => {}, detailRequested = Promise.resolve();
let hideRun = '';
const paperReads = new Set();
function hold(id) { holdRun = id; detailRequested = new Promise(resolve => { requested = resolve; }); return new Promise(resolve => { release = resolve; }); }
let held = Promise.resolve();
context.on('page', page => page.on('pageerror', error => result.errors.push(String(error))));
await context.route(/^https?:\/\//, async route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
  if (url.origin !== origin || !['GET', 'HEAD'].includes(method) || path.includes('/exports/')) { result.blocked.push({ method, path }); return route.abort('blockedbyclient'); }
  if (!path.startsWith('/api/t1/')) return route.continue();
  if (path.endsWith('/events')) {
    const id = decodeURIComponent(path.split('/').at(-2)), known = Object.values(runtime.ids).includes(id);
    const event = run_id => ({ run_id, seq: 1, type: 'state', timestamp: '2026-11-14T00:00:00Z', detail: { state: 'extracting', summary: `ONLY ${run_id} EVENT` } });
    const events = known ? (id === runtime.ids.newer ? [event(runtime.ids.older), event(id)] : [event(id)]) : [];
    return route.fulfill({ contentType: 'text/event-stream', body: events.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + ': finite snapshot\n\n' });
  }
  const run = path.match(/^\/api\/t1\/workbench\/runs\/([^/]+)$/)?.[1];
  if (run === holdRun) { requested(); await held; }
  if (run === failRun) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'isolated_detail_unavailable' }) });
  const response = await fetch(backend + path.replace(/^\/api\/t1/, '/api') + url.search);
  let body = Buffer.from(await response.arrayBuffer());
  if (hideRun && path === '/api/t1/workbench/runs') { const value = JSON.parse(body); value.runs = value.runs.filter(run => run.run_id !== hideRun); body = Buffer.from(JSON.stringify(value)); }
  if (/\/workbench\/papers\/[^/]+$/.test(path)) paperReads.add(path);
  try { await route.fulfill({ status: response.status, contentType: response.headers.get('content-type') ?? 'application/json', body }); } catch { /* A delayed old read may have been aborted by task navigation. */ }
});
const page = await context.newPage(); page.setDefaultTimeout(12_000);
const query = (run, view = 'records', legacy = false) => origin + '/?' + new URLSearchParams({ paper: runtime.paper_id, [legacy ? 'history' : 'run']: run, view });
async function save() { const path = join(evidence, 'report.json'), report = JSON.parse(await readFile(path, 'utf8')); report.item4[`browser_${phase}`] = result; await writeFile(path, JSON.stringify(report, null, 2) + '\n'); }
async function check(name, work) { try { await work(); result.checks.push({ name, status: 'passed' }); console.log('PASS ' + name); } catch (error) { result.checks.push({ name, status: 'failed', error: String(error) }); console.log('FAIL ' + name + '\n' + String(error)); } finally { release(); holdRun = ''; failRun = ''; hideRun = ''; await save(); } }
async function selected(id) { await page.waitForFunction(id => document.querySelector(`[data-submission-list="sidebar"] [data-run-id="${id}"]`)?.getAttribute('aria-current') === 'page', id); }
async function figures() { return page.locator('.t1-figure img').evaluateAll(images => images.map(image => image.getAttribute('src'))); }
try {
  const caps = await (await fetch(backend + '/api/workbench/capabilities')).json(); assert.equal(caps.controlled_fixture, true);
  await check('exact_runs_and_zero_result_never_accumulate_same_paper_records', async () => {
    for (const [name, count] of [['older', 1], ['newer', 2], ['empty', 0]]) {
      const id = runtime.ids[name]; await page.goto(query(id)); await selected(id);
      if (count) await page.locator('.t1-evidence-card').waitFor();
      else await page.waitForFunction(() => !document.querySelector('.t1-evidence-card') && document.querySelector('[data-retention-count="kept"]')?.textContent === '0');
      assert.equal(await page.locator('[data-retention-count="kept"]').innerText(), String(count));
      assert.equal(new URL(page.url()).searchParams.get('run'), id);
      if (count) { const detail = await (await fetch(backend + '/api/workbench/runs/' + id)).json(); assert.equal(await page.locator('.t1-evidence-card').getAttribute('data-record-id'), detail.output.records[0].id); }
    }
  });
  await check('loading_exact_run_does_not_borrow_paper_latest_figures_or_sources', async () => {
    paperReads.clear(); held = hold(runtime.ids.older);
    await page.goto(query(runtime.ids.older, 'figures')); await detailRequested;
    await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes('Figure'));
    for (let n = 0; n < 50 && !paperReads.size; n++) await new Promise(resolve => setTimeout(resolve, 20));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const sources = await figures(); result.observations.push({ case: 'loading_exact_run', figure_urls: sources });
    await page.screenshot({ path: join(evidence, `item4-${phase}-loading.png`) });
    assert.deepEqual(sources, []); assert.equal(await page.locator('.t1-source').count(), 0); assert.equal(await page.locator('.t1-exports').count(), 0);
    release(); holdRun = ''; await page.locator('.t1-figure img').first().waitFor();
    assert.ok((await figures()).every(url => url.includes(`/runs/${runtime.ids.older}/figures/`)));
  });
  await check('failed_exact_run_does_not_borrow_latest_source_or_figure_views', async () => {
    failRun = runtime.ids.older; await page.goto(query(runtime.ids.older, 'figures')); await selected(runtime.ids.older);
    await page.getByRole('alert').filter({ hasText: 'isolated_detail_unavailable' }).waitFor();
    const sources = await figures(); result.observations.push({ case: 'failed_exact_run', figure_urls: sources }); assert.deepEqual(sources, []);
    assert.equal(await page.locator('.t1-evidence-card').count(), 0); assert.equal(await page.locator('.t1-exports').count(), 0);
  });
  await check('unavailable_or_deleted_explicit_run_never_substitutes_a_different_task', async () => {
    await page.goto(query('deleted-run')); await page.locator('.t1-workbench').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-submission-list="sidebar"] [data-run-id]'));
    const actual = new URL(page.url()).searchParams.get('run'); result.observations.push({ case: 'unavailable_explicit_run', actual_run: actual });
    assert.equal(actual, 'deleted-run'); assert.equal(await page.locator('.t1-evidence-card').count(), 0); assert.equal(await page.locator('.t1-exports').count(), 0);
  });
  await check('valid_historical_run_link_uses_its_own_source_and_figures', async () => {
    await page.goto(query(runtime.ids.older, 'figures', true)); await page.locator('.t1-figure img').first().waitFor();
    const sources = await figures(); result.observations.push({ case: 'historical_exact_run', figure_urls: sources });
    assert.ok(sources.length > 0 && sources.every(url => url.includes(`/runs/${runtime.ids.older}/figures/`)));
  });
  if (phase === 'after') {
    await check('an_unmapped_historical_output_keeps_only_its_exact_text_and_declares_source_missing', async () => {
      hideRun = runtime.ids.older;
      await page.goto(query(runtime.ids.older, 'records', true)); await page.locator('.t1-evidence-card').waitFor();
      assert.equal(new URL(page.url()).searchParams.get('history'), runtime.ids.older);
      assert.equal(await page.locator('[data-retention-count="kept"]').innerText(), '1');
      await page.getByText('这次历史结果缺少可用的任务来源。已保存文字仍可查看，图片与来源定位不可用。', { exact: true }).waitFor();
      assert.equal(await page.locator('.t1-retention').count(), 0); assert.equal(await page.locator('.t1-exports').count(), 0);
      await page.getByRole('tab', { name: '原 Figure 目录', exact: true }).click(); assert.deepEqual(await figures(), []);
      await page.screenshot({ path: join(evidence, 'item4-after-legacy-source-missing.png') });
      await page.goto(query('unknown-history', 'records', true));
      await page.getByText('当前任务不可用或已删除。请选择其他任务查看对应结果。', { exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('history'), 'unknown-history'); assert.equal(await page.locator('.t1-evidence-card').count(), 0);
    });
    await check('a_late_previous_detail_and_foreign_SSE_event_do_not_replace_the_selected_task', async () => {
      held = hold(runtime.ids.older); await page.goto(query(runtime.ids.older)); await detailRequested;
      await page.locator(`[data-submission-list="sidebar"] [data-run-id="${runtime.ids.newer}"]`).click(); await selected(runtime.ids.newer);
      release(); holdRun = ''; await page.locator('.t1-evidence-card').waitFor();
      await page.waitForFunction(() => document.querySelector('[data-retention-count="kept"]')?.textContent === '2');
      await page.locator('.t1-notes-toggle').click(); await page.getByText('这次抽取的事件', { exact: true }).click();
      await page.waitForFunction(id => document.querySelector('.t1-events')?.textContent?.includes(`ONLY ${id} EVENT`), runtime.ids.newer);
      const events = await page.locator('.t1-events').innerText(); assert.ok(!events.includes(`ONLY ${runtime.ids.older} EVENT`));
      assert.equal(new URL(page.url()).searchParams.get('run'), runtime.ids.newer); await page.keyboard.press('Escape');
    });
    await check('same_record_id_keeps_source_editor_drafts_separate_between_tasks', async () => {
      async function openEditor(id) {
        await page.locator(`[data-submission-list="sidebar"] [data-run-id="${id}"]`).click(); await selected(id); await page.locator('.t1-evidence-card').waitFor();
        await page.locator('[data-index-record-id="replay-shared-record"]').click();
        await page.locator('.t1-notes-toggle').click(); await page.getByRole('button', { name: '修订来源或标签…', exact: true }).click();
        return page.getByLabel('审核人补充（与原文分开）', { exact: true });
      }
      const a = await openEditor(runtime.ids.older); await a.fill('Task A draft only'); await page.keyboard.press('Escape');
      const b = await openEditor(runtime.ids.newer); assert.equal(await b.inputValue(), ''); await b.fill('Task B draft only'); await page.keyboard.press('Escape');
      const restored = await openEditor(runtime.ids.older); assert.equal(await restored.inputValue(), 'Task A draft only');
      const keys = await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('t1:source-draft:')));
      assert.ok(keys.some(key => key.includes(runtime.ids.older)) && keys.some(key => key.includes(runtime.ids.newer))); await page.keyboard.press('Escape');
    });
    await page.goto(query(runtime.ids.older)); await selected(runtime.ids.older); await page.locator('.t1-evidence-card').waitFor();
    await page.screenshot({ path: join(evidence, 'item4-after-current-task.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(evidence, 'item4-after-mobile.png') });
  }
  result.status = result.checks.every(check => check.status === 'passed') && !result.errors.length && !result.blocked.length ? 'passed' : 'failed';
  console.log(JSON.stringify({ status: result.status, passed: result.checks.filter(check => check.status === 'passed').length, failed: result.checks.filter(check => check.status === 'failed').length }));
  if (result.status !== 'passed') process.exitCode = 1;
} finally { release(); await browser.close(); await save(); }
