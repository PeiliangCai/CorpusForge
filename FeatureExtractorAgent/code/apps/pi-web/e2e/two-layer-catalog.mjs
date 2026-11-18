/** Built Next gateway -> isolated workflow/config only; no real database operations or paid models. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const origin = 'http://127.0.0.1:30155', evidence = join(code, 'docs/acceptance/two-layer-catalog-2026-11-14');
const runtime = JSON.parse(await readFile(join(code, 'runtime-data/two-layer-catalog-fixture-20261114/runtime.json'), 'utf8'));
const configPath = join(runtime.directory, 'config/scope-catalog.json'), original = JSON.parse(await readFile(configPath, 'utf8'));
const dist = 'apps/pi-web/build/two-layer-catalog-validated-20261114';
const result = { status: 'in_progress', origin, isolated_backend: 'http://127.0.0.1:3215', dist,
  BUILD_ID: (await readFile(join(code, dist, 'BUILD_ID'), 'utf8')).trim(), checks: [], errors: [], blocked: [], mutations: [], screenshots: [], paid_model_calls: 0, production_business_writes: 0 };
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
await context.addInitScript(expected => { if (location.origin === expected) { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); } }, origin);
let failStartNumber = 0, startNumber = 0;
await context.route(/^https?:\/\//, async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== origin) { result.blocked.push({ path: url.pathname, method: request.method() }); return route.abort('blockedbyclient'); }
  if (url.pathname.startsWith('/api/t1/') && !['GET', 'HEAD'].includes(request.method())) {
    result.mutations.push({ method: request.method(), path: url.pathname });
    if (request.method() === 'POST' && /\/papers\/[^/]+\/runs$/.test(url.pathname)) {
      startNumber++;
      if (startNumber === failStartNumber) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"controlled_submission_failure"}' });
    }
  }
  return route.continue();
});
const page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => result.errors.push(String(error)));
const json = async path => { const response = await context.request.get(origin + '/api/t1/workbench/' + path); assert.equal(response.status(), 200, path); return response.json(); };
const batch = () => page.locator('.t1-batch');
const cancer = () => page.getByLabel('癌种', { exact: true });
const modality = () => page.getByLabel('图像模态', { exact: true });
const scopeEditor = () => page.locator('.t1-scope-editor');
const check = async (name, action) => { await action(); result.checks.push(name); console.log('PASS ' + name); };
async function edit(value) { await writeFile(configPath, JSON.stringify(value, null, 2) + '\n'); }
async function refresh() { await page.getByRole('button', { name: '刷新工作台', exact: true }).click(); await page.locator('.t1-refresh-toast').waitFor(); await page.waitForFunction(() => !document.querySelector('.t1-refresh-center')); }
async function idle() { await page.locator('.t1-batch[aria-busy="false"]').waitFor(); }
async function newTask() { await page.goto(origin + '/?view=newTask'); await scopeEditor().waitFor(); }
async function selectLungCt() { await cancer().selectOption('selected'); await scopeEditor().getByRole('checkbox', { name: '肺癌', exact: true }).check(); await modality().selectOption('selected'); await scopeEditor().getByRole('checkbox', { name: 'CT', exact: true }).check(); }
async function files(names) { const bytes = await readFile(join(code, 'evaluation/corpus/development-candidates/L01.pdf')); await page.getByLabel('选择 PDF', { exact: true }).setInputFiles(names.map(name => ({ name, mimeType: 'application/pdf', buffer: bytes }))); }
async function saveScreenshot(name) { await page.screenshot({ path: join(evidence, name), fullPage: true }); result.screenshots.push(name); }
const persist = async () => { const report = JSON.parse(await readFile(join(evidence, 'report.json'), 'utf8')); report.browser = result; await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n'); };
try {
  assert.equal((await json('capabilities')).controlled_fixture, true);
  assert.ok((await json('runs')).runs.some(run => run.run_id === runtime.run), 'the unchanged gateway must reach only the isolated fixture');
  await check('exactly_two_default_unrestricted_layers_and_empty_selection_blocks_start', async () => {
    await newTask(); assert.equal(await scopeEditor().locator('fieldset').count(), 2);
    assert.equal(await cancer().inputValue(), 'all'); assert.equal(await modality().inputValue(), 'all');
    assert.equal(await page.getByLabel('视觉特征', { exact: true }).count(), 0);
    await files(['single.pdf']); await batch().getByRole('button', { name: '上传待处理 PDF（1 篇）', exact: true }).click(); await idle();
    await cancer().selectOption('selected'); assert.ok((await scopeEditor().innerText()).includes('请至少选择一项'));
    assert.equal(await batch().getByRole('button', { name: '开始单篇抽取（1 篇）', exact: true }).isDisabled(), true);
    await scopeEditor().getByRole('checkbox', { name: '肺癌', exact: true }).check();
    await saveScreenshot('scope-desktop.png');
  });
  await check('unrefreshed_version_is_409_with_clear_feedback_then_refresh_preserves_ids', async () => {
    const before = await json('catalog'), changed = structuredClone(original); changed.cancers[0].description = '修改后保存即刷新，无医学批准'; await edit(changed);
    const status = page.waitForResponse(response => response.request().method() === 'POST' && /\/papers\/[^/]+\/runs$/.test(response.url()));
    await batch().getByRole('button', { name: '开始单篇抽取（1 篇）', exact: true }).click(); await idle();
    assert.equal((await status).status(), 409); assert.ok((await batch().innerText()).includes('范围选项已更新，请刷新工作台'));
    await refresh(); assert.equal(await scopeEditor().getByRole('checkbox', { name: '肺癌', exact: true }).isChecked(), true);
    assert.notEqual((await json('catalog')).catalog_version, before.catalog_version);
    assert.equal(await batch().getByRole('button', { name: '开始单篇抽取（1 篇）', exact: true }).isEnabled(), true);
  });
  await check('add_rename_delete_and_dependency_updates_need_no_restart_and_never_drop_invalid_ids', async () => {
    await batch().getByRole('button', { name: '清空本次选择', exact: true }).click();
    const changed = structuredClone(original); changed.cancers.push({ id: 'CANCER-ENGINEERING', name: '隔离新增项', image_type_ids: ['MODALITY-CT'] });
    changed.cancers[0].name = '肺癌（改名）'; changed.cancers[0].image_type_ids = ['MODALITY-CT']; changed.cancers[1].image_type_ids = ['MODALITY-MRI'];
    await edit(changed); await refresh(); assert.equal(await scopeEditor().getByRole('checkbox', { name: '肺癌（改名）', exact: true }).isChecked(), true);
    await scopeEditor().getByRole('checkbox', { name: '隔离新增项', exact: true }).check();
    changed.cancers.pop(); await edit(changed); await refresh();
    const removed = scopeEditor().getByRole('checkbox', { name: /CANCER-ENGINEERING/ }); assert.equal(await removed.isChecked(), true); await removed.click(); assert.equal(await removed.count(), 0);
    await modality().selectOption('selected'); await scopeEditor().getByRole('checkbox', { name: 'CT', exact: true }).check();
    await scopeEditor().getByRole('checkbox', { name: '肺癌（改名）', exact: true }).uncheck(); await scopeEditor().getByRole('checkbox', { name: '肠癌', exact: true }).check();
    assert.equal(await scopeEditor().getByRole('checkbox', { name: /CT.*此项已不适用/ }).isChecked(), true);
    assert.equal(await scopeEditor().getByRole('checkbox', { name: 'MRI', exact: true }).count(), 1);
    await scopeEditor().getByRole('checkbox', { name: /CT.*此项已不适用/ }).click(); await scopeEditor().getByRole('checkbox', { name: 'MRI', exact: true }).check();
    assert.equal(await scopeEditor().locator('.t1-invalid-choice').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 }); await saveScreenshot('scope-mobile.png'); await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await check('admitted_batch_retries_keep_server_catalog_after_config_changes', async () => {
    await edit(original); await newTask(); await selectLungCt(); await files(['batch-a.pdf', 'batch-b.pdf', 'batch-c.pdf']);
    await batch().getByRole('button', { name: '上传待处理 PDF（3 篇）', exact: true }).click(); await idle();
    failStartNumber = startNumber + 2;
    await batch().getByRole('button', { name: '批量开始抽取（3 篇）', exact: true }).click(); await idle();
    assert.equal(await page.locator('[data-upload-state="submitted"]').count(), 2); assert.equal(await page.locator('[data-upload-state="startFailed"]').count(), 1);
    const before = (await json('runs')).runs.filter(run => run.submission?.kind === 'batch'), version = before[0].scope_catalog.catalog_version;
    const changed = structuredClone(original); changed.cancers.shift(); await edit(changed); await refresh();
    assert.equal(await scopeEditor().getByRole('checkbox', { name: /CANCER-LUNG.*此项已不适用/ }).isChecked(), true);
    assert.equal(await page.getByRole('button', { name: '重试提交抽取', exact: true }).isEnabled(), true);
    await page.getByRole('button', { name: '重试提交抽取', exact: true }).click(); await idle();
    assert.equal(await page.locator('[data-upload-state="submitted"]').count(), 3);
    const after = (await json('runs')).runs.filter(run => run.submission?.kind === 'batch' && run.submission.batch_id === before[0].submission.batch_id); assert.equal(after.length, 3);
    assert.ok(after.every(run => run.scope_catalog.catalog_version === version)); assert.ok(after.every(run => run.scope.cancers.ids[0] === 'CANCER-LUNG'));
  });
  await check('historical_scope_names_use_admission_snapshot_and_bad_json_keeps_saved_tasks_visible', async () => {
    const changed = structuredClone(original); changed.cancers[0].name = '肺癌（当前已改名）'; await edit(changed);
    await page.goto(origin + '/?' + new URLSearchParams({ paper: runtime.paper, run: runtime.run, view: 'records' })); await page.locator('.t1-evidence-card').waitFor();
    await page.getByRole('button', { name: '说明', exact: true }).click(); const saved = page.locator('.t1-note-disclosure').filter({ has: page.getByText('已保存范围', { exact: true }) });
    await saved.locator('summary').click(); assert.ok((await saved.innerText()).includes('肺癌')); assert.ok(!(await saved.innerText()).includes('当前已改名'));
    await page.getByRole('button', { name: '关闭说明', exact: true }).click();
    await writeFile(configPath, '{broken'); await refresh();
    assert.equal(await page.locator('.t1-refresh-toast[data-failed="true"]').count(), 1);
    await page.goto(origin + '/?view=newTask'); await page.getByRole('alert').filter({ hasText: '范围配置' }).waitFor();
    assert.ok(await page.locator('[data-submission-list="sidebar"] [data-run-id]').count() >= 4); assert.equal(await scopeEditor().count(), 0);
    assert.equal(await page.locator('.t1-batch-actions .t1-primary').isDisabled(), true);
    await page.goto(origin + '/?' + new URLSearchParams({ paper: runtime.paper, run: runtime.run, view: 'records' })); await page.locator('.t1-evidence-card').waitFor();
    await edit(original); await refresh(); await page.getByRole('tab', { name: '创建任务', exact: true }).click(); await scopeEditor().waitFor();
    assert.equal(await scopeEditor().locator('fieldset').count(), 2);
  });
  assert.deepEqual(result.errors, []); assert.deepEqual(result.blocked, []);
  result.status = 'passed';
} catch (error) { result.status = 'failed'; result.failure = String(error?.stack ?? error); throw error; }
finally { await edit(original); await persist(); await browser.close(); }
