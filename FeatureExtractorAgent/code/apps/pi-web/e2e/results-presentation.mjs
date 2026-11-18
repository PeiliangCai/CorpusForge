/** HISTORICAL individual-approval UI check. New daily retention workbenches fail before browser/data actions. */
/** Read-only checks against real saved T1 results. No exports, approvals, uploads or model calls. */
import assert from 'node:assert/strict';
import { requireLegacyReviewWorkflow } from './legacy-review-guard.mjs';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const origin = process.env.T1_UI_ORIGIN ?? 'http://127.0.0.1:30151';
const evidence = resolve(process.env.T1_UI_EVIDENCE ?? join(code, 'docs/acceptance/resume-2026-11-11/ui'));
assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use a local read-only workbench');
await requireLegacyReviewWorkflow(origin, 'results-presentation.mjs');
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
await mkdir(evidence, { recursive: true });
const report = { schema_version: 't1-results-ui-1', at: new Date().toISOString(), origin, source: 'Existing real saved candidates; no generated or injected medical results', checks: [], screenshots: [], errors: [], failedResponses: [], blockedRequests: [], paid_model_calls: 0, production_write_requests: 0, exports_requested: 0, medical_quality_approved: false };
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1512, height: 1050 }, reducedMotion: 'reduce' });
// PDF popups include opaque viewer frames. Seed only app documents, leaving those frames alone.
await context.addInitScript(expectedOrigin => {
  if (location.origin !== expectedOrigin) return;
  try { localStorage.setItem('pi-theme', 'light'); localStorage.setItem('pi-locale', 'zh-CN'); } catch { /* Opaque PDF viewer frames have no app storage. */ }
}, origin);
await context.route(/^https?:\/\//, route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()) || url.pathname.includes('/exports/')) {
    report.blockedRequests.push({ method: request.method(), path: url.pathname, external: url.origin !== origin });
    return route.abort('blockedbyclient');
  }
  return route.continue();
});
context.on('page', page => page.on('pageerror', error => report.errors.push(String(error))));
context.on('response', response => { if (response.status() >= 400) report.failedResponses.push({ status: response.status(), path: new URL(response.url()).pathname }); });
const page = await context.newPage();
const json = async path => {
  assert.ok(!path.includes('/exports/'));
  const response = await context.request.get(`${origin}/api/t1/${path}`);
  assert.equal(response.status(), 200, path);
  return response.json();
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const persist = () => writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
async function check(name, work) {
  try { const detail = await work(); report.checks.push({ name, status: 'passed', detail }); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.stack ?? String(error) }); throw error; }
  finally { await persist(); }
}
async function top() { await page.locator('.t1-content').evaluate(element => { element.scrollTop = 0; }); }
async function capture(name) { await top(); await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: join(evidence, name) }); report.screenshots.push(name); }
async function openRun(run, record, view = 'records') {
  const params = new URLSearchParams({ paper: run.document_id, run: run.run_id, view });
  if (record) params.set('record', record.id);
  await page.goto(`${origin}/?${params}`);
  if (view === 'records') await page.locator('.t1-evidence-card').waitFor();
  await page.evaluate(() => document.fonts.ready);
}
async function choose(record) {
  const index = page.locator(`[data-index-record-id="${record.id}"]`);
  if (await index.isVisible()) await index.click();
  else await page.getByLabel('原文记录', { exact: true }).selectOption(record.id);
  await page.locator(`article[data-record-id="${record.id}"]`).waitFor();
}
async function exactSource(record) {
  assert.deepEqual(await page.locator('.t1-quote-frame .t1-verbatim').allTextContents(), record.fragments.map(fragment => fragment.exact_quote));
  assert.equal(await page.locator('.t1-quote-frame [data-fragment-index]').count(), record.fragments.length);
  assert.equal(await page.locator('.t1-evidence-card').getAttribute('data-record-version'), String(record.version));
}
async function theme(name) {
  await page.getByRole('button', { name: '界面主题', exact: true }).click();
  await page.getByRole('menuitemradio', { name: name === 'dark' ? '深色' : '浅色', exact: true }).click();
  await page.waitForFunction(value => document.documentElement.dataset.theme === value, name);
  await page.waitForTimeout(350);
}
let run, detail, records, baseline;
try {
  const caps = await json('workbench/capabilities');
  assert.equal(caps.extraction_start, false);
  assert.equal(caps.controlled_fixture, false);
  const { runs } = await json('workbench/runs');
  run = runs.find(item => item.document_id === 'L07' && item.candidate_count > 0);
  assert.ok(run, 'Real retained L07 results required');
  detail = await json(`workbench/runs/${encodeURIComponent(run.run_id)}`);
  baseline = hash(detail.output);
  records = detail.output.records.filter(record => !record.deleted);
  report.saved_run = { run_id: run.run_id, paper_id: run.document_id, records: records.length, text_approved: records.filter(record => record.text_approved).length, source_status: detail.source_status, legacy_state: run.state, fixture: detail.output.fixture ?? false, output_sha256_before: baseline };

  await check('default_entry_surfaces_real_saved_results', async () => {
    await page.goto(origin + '/'); await page.locator('.t1-evidence-card').waitFor(); await page.evaluate(() => document.fonts.ready);
    const params = new URL(page.url()).searchParams;
    assert.equal(params.get('paper'), 'L07'); assert.equal(params.get('view'), 'records'); assert.equal(params.get('run'), run.run_id);
    assert.equal(await page.locator('.t1-source').count(), 0);
    await exactSource(records[0]);
    assert.equal(await page.locator('[data-count-kind="candidates"] dd').innerText(), String(records.length));
    assert.equal(await page.locator('[data-count-kind="approved"] dd').innerText(), String(records.filter(record => record.text_approved).length));
    assert.equal(await page.locator('[data-count-kind="pending"] dd').innerText(), String(records.filter(record => !record.text_approved && record.review_status !== 'rejected').length));
    const frame = await page.locator('.t1-quote-frame').boundingBox(), first = await page.locator('.t1-quote-frame .t1-verbatim').first().boundingBox();
    assert.ok(frame.y < 430, `Source frame must be prominent: y=${frame.y}`); assert.ok(first.y < 580, `Source text must be in first viewport: y=${first.y}`);
    const short = records.find(record => record.fragments[0]?.exact_quote.length < 20 && record.fragments.length > 1);
    if (short) assert.ok((await page.locator(`[data-index-record-id="${short.id}"] .t1-index-preview`).textContent()).includes(short.fragments[1].exact_quote));
    const client = await context.newCDPSession(page); await client.send('DOM.enable'); await client.send('CSS.enable');
    const { root } = await client.send('DOM.getDocument'), { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.t1-quote-frame .t1-verbatim' });
    const fonts = (await client.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
    assert.ok(fonts.some(font => font.isCustomFont && font.familyName === 'Noto Sans CJK SC')); await client.detach();
    await capture('L07-desktop-light.png');
    return { frame_top: frame.y, first_source_text_top: first.y, source_font: fonts.map(font => font.familyName), candidates: records.length, no_approval_inferred: true };
  });

  await check('index_next_search_and_role_filter_preserve_exact_originals', async () => {
    await page.getByRole('button', { name: '下一条记录', exact: true }).click(); await exactSource(records[1]);
    await page.getByRole('button', { name: '上一条记录', exact: true }).click(); await exactSource(records[0]);
    await page.getByLabel('查找原文或语境…', { exact: true }).fill('__no_actual_source_matches_this__');
    await page.locator('.t1-search-empty').waitFor(); assert.equal(await page.locator('.t1-evidence-card').count(), 0);
    await page.getByLabel('查找原文或语境…', { exact: true }).fill(''); await page.locator('.t1-evidence-card').waitFor();
    const backgrounds = records.filter(record => record.evidence_role === 'background_suggestion');
    await page.getByLabel('候选类型', { exact: true }).selectOption('background_suggestion');
    if (backgrounds.length) { await page.locator('article[data-record-id="' + backgrounds[0].id + '"]').waitFor(); await exactSource(backgrounds[0]); assert.equal(await page.locator('.t1-evidence-title h2').innerText(), '补充背景原文'); }
    else await page.locator('.t1-search-empty').waitFor();
    await page.getByLabel('候选类型', { exact: true }).selectOption('all'); await page.locator('.t1-evidence-card').waitFor();
    await choose(records.at(-1)); await exactSource(records.at(-1)); await choose(records[0]);
    return { background_records: backgrounds.length, preview_boundaries: 'Explicit ellipsis between source fragments; full selected text unchanged' };
  });

  await check('deep_links_restore_exact_paper_run_record_view_and_history', async () => {
    const selected = records.find(record => record.context.length) ?? records[2];
    await openRun(run, selected); await exactSource(selected); await page.reload(); await page.locator('.t1-evidence-card').waitFor(); await exactSource(selected);
    await page.goto(origin + '/?' + new URLSearchParams({ paper: run.document_id, history: detail.output.id, record: selected.id, view: 'records' }));
    await page.locator('.t1-evidence-card').waitFor(); await exactSource(selected); assert.equal(new URL(page.url()).searchParams.has('run'), false);
    await openRun(run, records[0]);
    return { exact_record: selected.id, exact_version: selected.version, historical_link_preserved: true };
  });

  await check('same_source_members_and_review_gates_remain_independent', async () => {
    const group = detail.output.same_source_review_index?.groups.find(group => group.member_count > 1 && group.members.every(member => records.some(record => record.id === member.record_id)));
    if (group) {
      const first = records.find(record => record.id === group.members[0].record_id), second = records.find(record => record.id === group.members[1].record_id);
      await choose(first); await page.locator('.t1-same-source > summary').click(); await page.locator('.t1-member-list > div').nth(1).locator('button').first().click(); await exactSource(second);
    }
    await choose(records[0]);
    const review = page.locator('.t1-review');
    assert.equal(await review.getByRole('button', { name: '批准当前文字', exact: true }).isEnabled(), false);
    await review.getByLabel('审核人', { exact: true }).fill('只读界面验证');
    for (const label of ['已核对原文与来源一致', '已核对相关性与证据角色', '已核对必要语境、条件与否定']) await review.getByLabel(label, { exact: true }).check();
    assert.equal(await review.getByRole('button', { name: '批准当前文字', exact: true }).isEnabled(), true);
    assert.equal(await review.getByRole('button', { name: '批准当前图片', exact: true }).isEnabled(), false);
    await openRun(run, records[0]);
    return { same_source_group_checked: Boolean(group), approval_actions_clicked: 0, text_and_image_controls: 'Independent; no saved approval changed' };
  });

  await check('source_limit_status_is_visible_and_expands_saved_details', async () => {
    const chip = page.locator('.t1-source-limits-chip');
    assert.equal(await chip.isVisible(), true); assert.ok((await chip.boundingBox()).y < 300);
    await chip.click(); assert.equal(await page.locator('.t1-task-details').getAttribute('open'), '');
    assert.equal(await page.locator('.t1-source-limits').isVisible(), true);
    await page.locator('.t1-task-details > summary').click(); await top();
    return { visible_source_limit_flag: true, task_status: await page.locator('.t1-task-progress').innerText(), source_and_task_completion_separate: true };
  });

  await check('three_interface_languages_share_clear_result_navigation_without_translating_sources', async () => {
    for (const [locale, label] of [['en', 'Extraction results'], ['zh-TW', '擷取結果'], ['zh-CN', '抽取结果']]) {
      await page.locator('.t1-top-actions select').selectOption(locale);
      await page.getByRole('tab', { name: label, exact: true }).waitFor();
      assert.equal(await page.locator('.t1-heading h1').innerText(), label);
      await exactSource(records[0]);
    }
    return { locales: ['en', 'zh-TW', 'zh-CN'], source_translation: false };
  });

  await check('dark_theme_and_narrow_layout_keep_original_visible', async () => {
    await theme('dark'); await capture('L07-desktop-dark.png');
    const colors = await page.locator('.tabbar-scroll [role="tab"][aria-selected="true"]').evaluate(element => ({ background: getComputedStyle(element).backgroundColor, text: getComputedStyle(element).color }));
    for (const width of [390, 320, 768]) {
      await page.setViewportSize({ width, height: 844 }); await page.waitForTimeout(150); await top(); await exactSource(records[0]);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.querySelector('.t1-content').scrollWidth > document.querySelector('.t1-content').clientWidth + 1);
      assert.equal(overflow, false, `No horizontal overflow at ${width}px`);
      const first = await page.locator('.t1-quote-frame .t1-verbatim').first().boundingBox(); assert.ok(first.y < 640, `First source text visible at ${width}px: ${first.y}`);
      if (width === 390) { await capture('L07-mobile-dark.png'); report.mobile = { width, first_source_text_top: first.y }; }
    }
    await page.setViewportSize({ width: 390, height: 844 }); await theme('light'); await capture('L07-mobile-light.png');
    const popupPromise = context.waitForEvent('page'); await page.locator('.t1-locate').click(); const popup = await popupPromise;
    await popup.waitForURL('**#page=' + records[0].fragments[0].physical_page); assert.ok(popup.url().includes('/pdf#page=')); await popup.close();
    await page.setViewportSize({ width: 1512, height: 1050 }); await openRun(run, records[0]);
    return { widths_checked: [1512, 768, 390, 320], dark_tab_colors: colors, mobile_pdf_link_targets_physical_page: true };
  });

  await check('locate_opens_original_pdf_at_exact_physical_page', async () => {
    await page.locator('.t1-locate').click(); const physicalPage = records[0].fragments[0].physical_page;
    await page.locator(`.t1-pdf-reader canvas[data-page="${physicalPage}"]`).waitFor();
    assert.equal(await page.locator('.t1-source-toggle').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.t1-record-selector').isVisible(), true);
    await exactSource(records[0]); await capture('L07-source-comparison.png');
    await page.locator('.t1-source-toggle').click(); assert.equal(await page.locator('.t1-source').count(), 0);
    return { physical_page: physicalPage, original_pdf_sha256: detail.paper.sha256, pdf_opens_only_when_requested: true };
  });

  await check('whole_figure_caption_and_original_pi_web_image_preview', async () => {
    await page.getByRole('tab', { name: '原 Figure 目录', exact: true }).click();
    const figure = detail.figures.find(figure => figure.assets.length);
    assert.ok(figure, 'A retained whole-Figure asset is required');
    const section = page.locator(`section.t1-figure[aria-label="Figure ${figure.number ?? '?'}"]`).first();
    await section.waitFor(); await section.scrollIntoViewIfNeeded();
    assert.deepEqual(await section.locator('.t1-caption .t1-verbatim').allTextContents(), figure.caption.map(fragment => fragment.exact_quote));
    const image = section.locator('img').first(); await image.evaluate(image => image.decode());
    const dimensions = await image.evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight, fit: getComputedStyle(image).objectFit }));
    assert.equal(dimensions.width, figure.assets[0].width); assert.equal(dimensions.height, figure.assets[0].height); assert.equal(dimensions.fit, 'contain');
    await section.locator('button[aria-haspopup="dialog"]').first().click(); await page.locator('.image-preview-dialog[open]').waitFor(); await page.keyboard.press('Escape');
    assert.equal(await page.locator('.image-preview-dialog').count(), 0);
    await capture('L07-whole-figure.png');
    await openRun(run, records[0]);
    return { figure_id: figure.id, dimensions, original_caption_fragments: figure.caption.length, original_pi_web_dialog_used: true };
  });

  await check('chinese_originals_and_disabled_new_task_remain_available', async () => {
    const chineseRun = runs.find(item => item.document_id === 'L01' && item.candidate_count > 0);
    assert.ok(chineseRun); const chinese = await json(`workbench/runs/${encodeURIComponent(chineseRun.run_id)}`);
    await openRun(chineseRun); await exactSource(chinese.output.records.find(record => !record.deleted)); await capture('L01-chinese-source.png');
    await page.goto(origin + '/?view=newTask'); await page.locator('.t1-scope-editor').waitFor();
    assert.equal(await page.getByRole('button', { name: '开始抽取', exact: true }).isEnabled(), false);
    await openRun(run, records[0]);
    const after = await json(`workbench/runs/${encodeURIComponent(run.run_id)}`);
    assert.equal(hash(after.output), baseline); report.saved_run.output_sha256_after = hash(after.output);
    assert.equal((await json('workbench/capabilities')).extraction_start, false);
    return { chinese_source_fragments_exact: true, model_remains_disabled: true, saved_output_unchanged: true };
  });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.failedResponses, []); assert.deepEqual(report.blockedRequests, []);
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally { report.finished_at = new Date().toISOString(); await browser.close(); await persist(); }
console.log(JSON.stringify(report, null, 2));
