/** Run only after the main agent approves and switches the validated build.
 * Production GET/HEAD only: no uploads, starts, cancellations, deletes or exports. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const origin = 'http://127.0.0.1:30141', evidence = join(code, 'docs/acceptance/workbench-experience-2026-11-14');
const expectedBuild = (await readFile(join(code, 'apps/pi-web/build/workbench-experience-validated-20261114/BUILD_ID'), 'utf8')).trim();
const initial = JSON.parse(await readFile(join(evidence, 'initial-live-snapshot.json'), 'utf8'));
const result = { status: 'in_progress', origin, expected_BUILD_ID: expectedBuild, checks: [], errors: [], blocked: [], screenshots: [], production_business_writes: 0, exports_requested: 0, paid_model_calls: 0 };
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
await context.addInitScript(expected => { if (location.origin === expected) { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); } }, origin);
await context.route(/^https?:\/\//, route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()) || url.pathname.includes('/exports/')) { result.blocked.push({ method: request.method(), path: url.pathname }); return route.abort('blockedbyclient'); }
  return route.continue();
});
const page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => result.errors.push(String(error)));
const json = async path => { assert.ok(!path.includes('/exports/')); const response = await context.request.get(origin + '/api/t1/workbench/' + path); assert.equal(response.status(), 200, path); return response.json(); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const check = async (name, fn) => { await fn(); result.checks.push(name); console.log('PASS ' + name); };
const shot = async name => { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: join(evidence, name) }); result.screenshots.push(name); };
let before;
try {
  await check('production_serves_the_reviewed_build_and_real_saved_run', async () => {
    const manifest = await context.request.get(origin + '/_next/static/' + expectedBuild + '/_buildManifest.js'); assert.equal(manifest.status(), 200);
    assert.equal((await json('capabilities')).controlled_fixture, false); before = await json('runs/' + initial.run.id);
    assert.equal(before.paper.sha256, initial.document.file_sha256); assert.equal(before.run.fixture, false);
    result.run = { id: before.run.run_id, state: before.run.state, records: before.output.records.length, paired_records: before.output.records.filter(record => record.association === 'paired').length,
      progress: before.run.progress, source_text_sha256: hash(before.output.records.map(record => ({ id: record.id, fragments: record.fragments, context: record.context }))) };
    await page.goto(origin + '/?' + new URLSearchParams({ run: initial.run.id, view: 'records' })); await page.locator('.t1-evidence-card').waitFor();
  });
  await check('real_task_progress_matches_saved_partial_source_counts_and_elapsed_time', async () => {
    assert.equal(before.run.state, 'partial'); assert.equal(before.run.progress.completed, 2929); assert.equal(before.run.progress.total, 2929); assert.equal(before.run.progress.source_gap_blocks, 41); assert.equal(before.run.progress.summary_completed, false);
    const progress = page.locator('.t1-run-progress'); assert.equal(await progress.getAttribute('data-progress-stage'), before.run.state);
    if (before.run.state !== 'completed' || before.output.coverage?.task_processing_complete !== true) { assert.equal(await progress.getAttribute('data-progress-outcome'), 'incomplete'); assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), null); }
    if (before.run.progress?.source_gap_blocks) assert.ok((await progress.innerText()).includes(`${before.run.progress.source_gap_blocks} 块原文存在读取缺口`));
    if (before.run.progress?.completed !== undefined) assert.ok((await progress.innerText()).includes(`${before.run.progress.completed} / ${before.run.progress.total}`));
    if (before.run.execution_started_at && before.run.finished_at) {
      const seconds = Math.floor((Date.parse(before.run.finished_at) - Date.parse(before.run.execution_started_at)) / 1000), elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      assert.ok((await progress.innerText()).includes('已用时 ' + elapsed)); result.run.elapsed_display = elapsed;
    } else assert.ok((await progress.innerText()).includes('耗时未记录'));
    await shot('live-progress-desktop.png');
  });
  await check('real_explicit_figure_link_shows_original_full_figure_and_caption_without_approval', async () => {
    assert.equal(before.output.records.length, 13);
    const paired = before.output.records.filter(record => record.association === 'paired'); assert.equal(paired.length, 1);
    assert.equal(before.output.records.filter(record => record.association === 'no_explicit_reference').length, 12);
    const record = paired[0], figure = before.figures.find(item => record.figure_ids.includes(item.id) && item.number === '5'); assert.ok(figure?.assets.length);
    const index = page.locator(`[data-index-record-id="${record.id}"]`); if (await index.isVisible()) await index.click(); else await page.getByLabel('原文记录', { exact: true }).selectOption(record.id);
    await page.locator(`[data-record-id="${record.id}"]`).waitFor(); assert.deepEqual(await page.locator('.t1-quote-frame .t1-source-fragment').allTextContents(), record.fragments.map(fragment => fragment.exact_quote));
    await page.getByRole('button', { name: /查看对应配图/ }).click(); await page.waitForFunction(() => [...document.querySelectorAll('.t1-association img')].every(image => image.complete && image.naturalWidth > 0));
    assert.equal(await page.locator('.t1-association img').first().getAttribute('src'), figure.assets[0].url);
    const assetUrl = new URL(figure.assets[0].url, origin); assert.equal(assetUrl.origin, origin); const asset = await context.request.get(assetUrl.href); assert.equal(asset.status(), 200); assert.equal(createHash('sha256').update(await asset.body()).digest('hex'), figure.assets[0].sha256);
    assert.deepEqual(await page.locator('.t1-association .t1-caption .t1-source-fragment').allTextContents(), figure.caption.map(fragment => fragment.exact_quote));
    assert.equal(await page.getByRole('button', { name: /批准/ }).count(), 0); await shot('live-linked-figure-desktop.png');
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await shot('live-linked-figure-mobile.png'); await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await check('real_new_task_has_only_local_creation_two_scope_layers_and_existing_model_controls', async () => {
    if (!(await page.locator('.t1-new-task').isVisible())) await page.getByRole('button', { name: '切换任务导航', exact: true }).click();
    await page.locator('.t1-new-task').click(); await page.locator('.t1-scope-editor').waitFor(); assert.equal(await page.locator('.t1-scope-editor fieldset').count(), 2);
    assert.equal(await page.getByLabel('视觉特征', { exact: true }).count(), 0); assert.equal(await page.locator('.t1-reuse-paper').count(), 0); assert.equal(await page.locator('.t1-batch-actions .t1-primary').isDisabled(), true);
    assert.equal(await page.locator('.t1-model-selection').count(), 1); const models = await json('models'), configured = models.profiles.find(profile => profile.profile_id === models.default_profile_id); assert.ok(configured); assert.ok((await page.getByRole('button', { name: '抽取模型', exact: true }).innerText()).includes(configured.model_id));
    assert.equal(await page.getByRole('button', { name: '选择文件', exact: true }).count(), 1); assert.equal(await page.getByRole('button', { name: '选择文件夹', exact: true }).count(), 1); await shot('live-new-task-desktop.png');
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await shot('live-new-task-mobile.png');
  });
  await check('production_source_text_and_figure_links_remain_unchanged_after_readonly_inspection', async () => {
    const after = await json('runs/' + initial.run.id); assert.equal(hash(after.output.records), hash(before.output.records)); assert.equal(hash(after.figures), hash(before.figures));
    assert.deepEqual(result.errors, []); assert.deepEqual(result.blocked, []);
  });
  result.status = 'passed';
} catch (error) { result.status = 'failed'; result.failure = String(error?.stack ?? error); await page.screenshot({ path: join(evidence, 'live-ui-browser-failure.png') }).catch(() => {}); throw error; }
finally { const ui = JSON.parse(await readFile(join(evidence, 'ui.json'), 'utf8')); ui.live_readonly = result; await writeFile(join(evidence, 'ui.json'), JSON.stringify(ui, null, 2) + '\n'); await browser.close(); }
