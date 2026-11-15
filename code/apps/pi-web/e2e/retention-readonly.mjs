/** Deployment smoke: only GET/HEAD, no exports or real-user mutations, no model calls. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), origin = 'http://127.0.0.1:30141';
const evidence = join(code, 'docs/acceptance/linear-ui-2026-11-12');
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const report = { schema_version: 't1-linear-ui-ordinary-readonly-1', at: new Date().toISOString(), origin, paid_model_calls: 0,
  write_requests: 0, exports_requested: 0, Start_clicked: false, checks: [], errors: [], blocked: [] };
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const context = await browser.newContext({ viewport: { width: 1512, height: 1050 }, locale: 'zh-CN' });
await context.addInitScript(expectedOrigin => { if (location.origin !== expectedOrigin) return; try { localStorage.setItem('pi-theme', 'light'); localStorage.setItem('pi-locale', 'zh-CN'); } catch {} }, origin);
await context.route(/^https?:\/\//, route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()) || url.pathname.includes('/exports/')) { report.blocked.push({ method: request.method(), path: url.pathname }); return route.abort('blockedbyclient'); }
  return route.continue();
});
context.on('page', page => page.on('pageerror', error => report.errors.push(String(error))));
const json = async path => { const response = await context.request.get(origin + '/api/t1/' + path); assert.equal(response.status(), 200); return response.json(); };
const page = await context.newPage();
try {
  const caps = await json('workbench/capabilities'); assert.equal(caps.extraction_start, true); assert.equal(caps.persisted_retention, true); assert.equal(caps.retained_export, true);
  const runs = (await json('workbench/runs')).runs, run = runs.find(run => run.document_id === 'L07' && run.candidate_count === 26);
  assert.equal(runs.filter(run => !['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(run.state)).length, 0);
  const detail = await json('workbench/runs/' + encodeURIComponent(run.run_id)), record = detail.output.records.find(record => record.fragments.length >= 4 && record.passages.length === 1);
  report.checks.push({ name: 'ordinary_manual_model_limits_and_retention_capabilities_preserved', status: 'passed', limits: caps.model_runtime.limits, concurrent_slots: caps.max_concurrent_runs });
  await page.goto(origin + '/?' + new URLSearchParams({ paper: run.document_id, run: run.run_id, record: record.id, view: 'records' })); await page.locator('.t1-retention').waitFor();
  assert.deepEqual(await page.locator('.t1-quote-frame [data-fragment-index]').allTextContents(), record.fragments.map(fragment => fragment.exact_quote));
  assert.equal(await page.locator('.t1-quote-frame .t1-source-passage').count(), 1); assert.equal(await page.locator('.t1-retention input, .t1-retention textarea, .t1-review').count(), 0);
  assert.equal(await page.locator('[data-retention-count="kept"]').innerText(), '26'); assert.equal(await page.locator('[data-retention-count="excluded"]').innerText(), '0');
  await page.locator('.t1-exports > summary').click();
  assert.equal(await page.locator('.t1-exports button').count(), 3); assert.ok((await page.locator('.t1-exports').innerText()).includes('保留结果 JSONL'));
  await page.locator('.t1-exports > summary').click();
  await page.locator('.t1-notes-toggle').click(); await page.locator('dialog[open]').waitFor(); assert.equal(await page.locator('.t1-notes textarea, .t1-notes input').count(), 0); await page.keyboard.press('Escape');
  report.checks.push({ name: 'new_continuous_reading_and_keep_exclude_UI_served_on_30141', status: 'passed', record_id: record.id, source_fragments: record.fragments.length, displayed_paragraphs: 1, default_kept: 26, excluded: 0 });
  const buildId = (await readFile(join(code, 'apps/pi-web/build/linear-ui-final-next-20261112/BUILD_ID'), 'utf8')).trim();
  assert.equal((await context.request.get(origin + '/_next/static/' + buildId + '/_buildManifest.js')).status(), 200);
  report.checks.push({ name: 'final_build_static_manifest_and_readonly_network_boundary', status: 'passed', BUILD_ID: buildId });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.stack ?? String(error); throw error; }
finally { await writeFile(join(evidence, 'ordinary-readonly-browser.json'), JSON.stringify(report, null, 2) + '\n'); await browser.close(); }
