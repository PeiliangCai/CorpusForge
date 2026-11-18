/** Production GET/HEAD only. Never start, rerun, retain, export, cancel or delete. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), origin = 'http://127.0.0.1:30141';
const evidence = join(code, 'docs/acceptance/new-task-layout-2026-11-14/item5'), deployment = JSON.parse(await readFile(join(evidence, 'deployment.json'), 'utf8'));
const result = { status: 'running', BUILD_ID: deployment.BUILD_ID, checks: [], errors: [], blocked: [], production_business_writes: 0, paid_calls: 0, exports_requested: 0 };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const snapshots = async () => Object.fromEntries(await Promise.all(['runs', 'papers', 'models'].map(async name => [name, await fetch(origin + '/api/t1/workbench/' + name).then(response => response.json())])));
const before = await snapshots(); result.api_sha256_before = Object.fromEntries(Object.entries(before).map(([key, value]) => [key, hash(value)]));
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const singles = before.runs.runs.filter(run => run.submission?.kind === 'single' && run.task_completion?.processing_complete), members = before.runs.runs.filter(run => run.task_title === '测试2');
try {
  assert.equal((await fetch(origin, { method: 'HEAD' })).status, 200); assert.equal((await fetch('http://127.0.0.1:3210/health').then(r => r.json())).status, 'ok');
  assert.equal((await readFile(join(code, deployment.dist, 'BUILD_ID'), 'utf8')).trim(), result.BUILD_ID);
  result.checks.push('same_validated_build_and_backend_health');
  assert.equal(members.length, 2); assert.ok(members.every(run => run.task_processing_complete === false && run.task_completion?.rule_origin === 'legacy_evidence_projection' && run.task_completion.processing_complete));
  assert.equal(singles.length, 1); assert.equal(singles[0].task_processing_complete, false);
  const cancelled = before.runs.runs.filter(run => run.state === 'cancelled'); assert.ok(cancelled.length > 0 && cancelled.every(run => !run.task_completion?.processing_complete));
  result.checks.push('real_single_batch_projections_preserve_original_false_and_cancelled_status');
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
    await context.addInitScript(expected => { if (location.origin === expected) { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); } }, origin);
    await context.route('**/*', route => { const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin || !['GET', 'HEAD'].includes(req.method()) || /\/exports\//.test(url.pathname)) { result.blocked.push({ method: req.method(), path: url.pathname }); return route.abort('blockedbyclient'); }
      return route.continue(); });
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => result.errors.push(String(error)));
    const target = members[0]; await page.goto(`${origin}/?paper=${target.document_id}&run=${target.run_id}&view=records`);
    await page.locator('[data-batch-results]').waitFor();
    await page.waitForFunction(count => [...document.querySelectorAll('[data-retention-count]')].reduce((sum, element) => sum + Number(element.textContent), 0) === count, members.reduce((sum, run) => sum + run.candidate_count, 0));
    assert.equal(await page.locator('.t1-task-progress').getAttribute('data-status'), 'completedWithSourceGaps');
    assert.equal(await page.locator('[data-batch-results]').getAttribute('data-progress-outcome'), 'complete');
    assert.equal(await page.getByRole('progressbar', { name: '已结束论文', exact: true }).getAttribute('aria-valuenow'), '100');
    if (mobile && await page.locator('.t1-sidebar').isVisible()) await page.getByRole('button', { name: '切换导航', exact: true }).click();
    if (!mobile) await page.screenshot({ path: join(evidence, 'live-desktop.png') });
    const beforeRect = await page.locator('.t1-results-panel').boundingBox(); await page.getByRole('button', { name: '说明', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '说明', exact: true }); await dialog.locator('[data-source-gaps]').first().waitFor();
    assert.equal(await dialog.locator('[data-completion-run]').count(), 2); assert.match(await dialog.innerText(), /原始运行记录保留/);
    await dialog.locator('[data-source-gaps] summary').first().click(); assert.match(await dialog.innerText(), /原文识别存疑/);
    assert.doesNotMatch(await dialog.innerText(), /task-flow-completion-2|码点位置|5c8a80474c756be4422e/);
    assert.deepEqual(await page.locator('.t1-results-panel').boundingBox(), beforeRect);
    assert.ok((await dialog.boundingBox()).height <= (mobile ? 844 : 1000));
    await page.screenshot({ path: join(evidence, mobile ? 'live-source-gaps-mobile.png' : 'live-source-gaps-desktop.png') });
    await page.keyboard.press('Escape');
    if (!mobile) {
      const single = singles[0]; await page.goto(`${origin}/?paper=${single.document_id}&run=${single.run_id}&view=records`);
      await page.locator('.t1-run-progress[data-progress-outcome="complete"]').waitFor(); assert.equal(await page.locator('.t1-task-progress').getAttribute('data-status'), 'completedWithSourceGaps');
    }
    await context.close();
  }
  for (const member of members) {
    const detail = await fetch(`${origin}/api/t1/workbench/runs/${member.run_id}`).then(response => response.json());
    assert.deepEqual(detail.run.task_completion, detail.output.task_completion); assert.equal(detail.output.source_gaps.length, member.task_completion.source_gap_blocks);
    assert.ok(detail.output.source_gaps.some(gap => gap.uncertain_spans.some(span => Number.isInteger(span.start) && span.end > span.start)));
  }
  result.checks.push('real_desktop_mobile_saved_status_gap_pages_offsets_and_bounded_notes');
  const after = await snapshots(); result.api_sha256_after = Object.fromEntries(Object.entries(after).map(([key, value]) => [key, hash(value)]));
  assert.deepEqual(result.api_sha256_after, result.api_sha256_before); result.checks.push('all_task_paper_model_lists_preserved_by_GET_HEAD_checks');
  result.status = result.errors.length || result.blocked.length ? 'failed' : 'passed'; result.run_count = before.runs.runs.length; result.paper_count = before.papers.papers.length;
} catch (error) { result.errors.push(String(error)); result.status = 'failed'; }
finally { await browser.close(); result.completed_at_utc = new Date().toISOString(); await writeFile(join(evidence, 'live-readonly.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result)); }
if (result.status !== 'passed') process.exitCode = 1;
