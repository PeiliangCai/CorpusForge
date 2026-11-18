/** Production verification uses GET/HEAD only. Streams and all mutation/export routes are blocked in-browser. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), origin = 'http://127.0.0.1:30141', backend = 'http://127.0.0.1:3210';
const evidence = join(code, 'docs/acceptance/new-task-layout-2026-11-14'), path = join(evidence, 'report.json');
const report = JSON.parse(await readFile(path, 'utf8')), deployment = report.item4.feedback_20261115.deployment;
const result = { status: 'running', BUILD_ID: deployment.BUILD_ID, checks: [], blocked: [], errors: [], production_business_writes: 0, paid_calls: 0, exports_requested: 0, started_at_utc: new Date().toISOString() };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function snapshot() { const out = {}; for (const name of ['runs', 'papers', 'models']) { const response = await fetch(backend + '/api/workbench/' + name); assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer()); out[name] = { value: JSON.parse(bytes), sha256: digest(bytes) }; } return out; }
const before = await snapshot();
const startTicks = async pid => { const raw = await readFile('/proc/' + pid + '/stat', 'utf8'); return raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19]; };
const ticks = await startTicks(deployment.backend_pid);
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
await context.addInitScript(expected => { if (location.origin === expected) { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); } }, origin);
await context.route('**/*', async route => { const request = route.request(), url = new URL(request.url()); if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()) || url.pathname.includes('/exports/')) { result.blocked.push({ method: request.method(), path: url.pathname }); return route.abort('blockedbyclient'); } if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': readonly verification omits live stream\n\n' }); return route.continue(); });
const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => result.errors.push(String(error)));
try {
  const manifest = await context.request.head(origin + '/_next/static/' + deployment.BUILD_ID + '/_buildManifest.js'); assert.equal(manifest.status(), 200); const health = await (await fetch(backend + '/health')).json(); assert.equal(health.status, 'ok'); result.checks.push('same_validated_build_and_backend_health');
  const runs = before.runs.value.runs, batchMember = runs.find(run => run.submission?.kind === 'batch' && runs.filter(other => other.submission?.kind === 'batch' && other.submission.batch_id === run.submission.batch_id).reduce((n, other) => n + other.candidate_count, 0) > 0); assert.ok(batchMember);
  const members = runs.filter(run => run.submission?.kind === 'batch' && run.submission.batch_id === batchMember.submission.batch_id), expectedCount = members.reduce((n, run) => n + run.candidate_count, 0);
  await page.goto(origin + '/?' + new URLSearchParams({ paper: batchMember.document_id, run: batchMember.run_id, view: 'records' })); await page.locator('.t1-evidence-card').waitFor();
  await page.waitForFunction(count => { const kept = Number(document.querySelector('[data-retention-count="kept"]')?.textContent), excluded = Number(document.querySelector('[data-retention-count="excluded"]')?.textContent); return kept + excluded === count; }, expectedCount);
  const groupIds = new Set(runs.map(run => run.submission?.kind === 'batch' ? 'batch:' + run.submission.batch_id : 'run:' + run.run_id));
  assert.equal(await page.locator('[data-submission-list="sidebar"] [data-submission-group]').count(), groupIds.size); assert.equal(await page.locator('[data-submission-list="sidebar"] [data-submission-group="batch:' + batchMember.submission.batch_id + '"] [data-run-id]').count(), 1);
  const source = await page.locator('.t1-evidence-card').getAttribute('data-source-run-id'); assert.ok(members.some(run => run.run_id === source));
  assert.match(await page.locator('.t1-record-provenance').innerText(), new RegExp(members.find(run => run.run_id === source).original_filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(!(await page.locator('.t1-batch-overview > p').nth(1).innerText()).trim().endsWith('·'));
  await page.screenshot({ path: join(evidence, 'feedback-live-desktop.png') });
  const single = runs.find(run => run.submission?.kind === 'single' && run.candidate_count > 0); assert.ok(single); await page.locator('[data-submission-list="sidebar"] [data-run-id="' + single.run_id + '"]').click();
  await page.waitForFunction(id => document.querySelector('.t1-evidence-card')?.getAttribute('data-source-run-id') === id, single.run_id); assert.equal(await page.locator('[data-batch-results]').count(), 0);
  result.checks.push('real_submission_group_count_unified_results_and_exact_single_navigation');
  await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await page.screenshot({ path: join(evidence, 'feedback-live-mobile.png') });
  const after = await snapshot(); assert.deepEqual(Object.fromEntries(Object.entries(after).map(([key, item]) => [key, item.sha256])), Object.fromEntries(Object.entries(before).map(([key, item]) => [key, item.sha256]))); assert.equal(await startTicks(deployment.backend_pid), ticks);
  result.api_sha256_before = Object.fromEntries(Object.entries(before).map(([key, item]) => [key, item.sha256])); result.api_sha256_after = Object.fromEntries(Object.entries(after).map(([key, item]) => [key, item.sha256])); result.backend_pid_and_start_ticks_unchanged = true; result.run_count = runs.length; result.paper_count = before.papers.value.papers.length; result.task_count = groupIds.size; result.saved_model_profiles = before.models.value.profiles.map(({ profile_id, model_id, api, reasoning_effort }) => ({ profile_id, model_id, api, reasoning_effort })); result.checks.push('real_GET_HEAD_preserves_runs_papers_models_and_backend_identity');
  assert.deepEqual(result.blocked, []); assert.deepEqual(result.errors, []); result.status = 'passed';
} catch (error) { result.status = 'failed'; result.error = String(error); throw error; }
finally { await context.close(); await browser.close(); const current = JSON.parse(await readFile(path, 'utf8')); current.item4.feedback_20261115.live_readonly = { ...result, completed_at_utc: new Date().toISOString() }; await writeFile(path, JSON.stringify(current, null, 2) + '\n'); console.log(JSON.stringify(result)); }
