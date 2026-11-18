/** Live entry verification. Only fixed GET/HEAD requests are allowed; never opens the POST-based storage preview. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const code = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), evidence = join(code, 'docs/acceptance/storage-management-2026-11-15');
const origin = 'http://127.0.0.1:30141', BUILD_ID = process.env.T1_STORAGE_BUILD_ID ?? 'mYxCBdDdcBK7amEeDhlnC';
const allowedApi = new Set(['capabilities', 'catalog', 'papers', 'runs', 'models', 'storage'].map(name => '/api/t1/workbench/' + name));
const report = { status: 'running', method: 'Live production Next page and fixed business GET requests; every non-GET/HEAD, export and non-allowlisted API request is blocked. Storage preview is never opened.', origin, BUILD_ID, started_at: new Date().toISOString(), summary_phase: process.env.T1_STORAGE_SUMMARY_PHASE ?? 'before-backend-reference-fix', checks: [], request_log: [], blocked: [], errors: [], console_errors: [], layouts: {}, screenshots: [], paid_calls: 0, production_business_writes: 0, preview_requests: 0, cleanup_requests: 0, uploads: 0, exports: 0 };
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
await context.addInitScript(() => { localStorage.setItem('pi-locale', 'zh-CN'); localStorage.setItem('pi-theme', 'light'); });
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
  const entry = { source: 'browser', method, path };
  report.request_log.push(entry);
  if (url.origin !== origin || !['GET', 'HEAD'].includes(method) || /\/exports(?:\/|$)/.test(path) || path.startsWith('/api/') && !allowedApi.has(path)) {
    report.blocked.push(entry); return route.abort('blockedbyclient');
  }
  return route.continue();
});
async function get(path) {
  assert.ok(allowedApi.has(path) || path === '/' || path === `/_next/static/${BUILD_ID}/_buildManifest.js`);
  const response = await context.request.get(origin + path, { maxRedirects: 0 });
  const body = await response.body();
  report.request_log.push({ source: 'fixed-read', method: 'GET', path, status: response.status(), sha256: sha(body) });
  assert.equal(response.status(), 200, path);
  return { body, hash: sha(body), type: response.headers()['content-type'] ?? '' };
}
async function hashes() {
  const values = {};
  for (const name of ['papers', 'runs', 'models']) { const result = await get('/api/t1/workbench/' + name); values[name] = result.hash; }
  return values;
}
async function layout(page, name) {
  const metrics = await page.locator('.t1-storage-entry').evaluate(element => {
    const box = element.getBoundingClientRect();
    return { viewport_width: innerWidth, viewport_height: innerHeight, document_width: document.documentElement.scrollWidth, document_height: document.documentElement.scrollHeight, entry: { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }, storage_dialog_open: Boolean(document.querySelector('.t1-storage-dialog[open]')) };
  });
  assert.ok(metrics.document_width <= metrics.viewport_width + 1 && metrics.document_height <= metrics.viewport_height + 1, JSON.stringify(metrics));
  assert.ok(metrics.entry.x >= 0 && metrics.entry.y >= 0 && metrics.entry.right <= metrics.viewport_width + 1 && metrics.entry.bottom <= metrics.viewport_height + 1, JSON.stringify(metrics));
  assert.equal(metrics.storage_dialog_open, false);
  if (name === 'mobile') assert.ok(metrics.entry.height >= 44);
  report.layouts[name] = metrics;
  const filename = name === 'desktop' ? 'live-desktop.png' : 'live-mobile.png';
  await page.screenshot({ path: join(evidence, filename) }); report.screenshots.push(filename);
  report.checks.push(name + '_storage_entry_visible_without_overflow_or_preview');
}
try {
  await mkdir(evidence, { recursive: true });
  report.before_hashes = await hashes();
  const summaryResponse = await get('/api/t1/workbench/storage'), summary = JSON.parse(summaryResponse.body.toString('utf8'));
  assert.equal(summary.schema_version, 't1-storage-summary-1'); assert.equal(summary.scope, 'managed_workbench_files');
  for (const key of ['total_bytes', 'protected_bytes', 'reclaimable_bytes', 'unknown_bytes', 'file_count']) assert.ok(Number.isSafeInteger(summary[key]) && summary[key] >= 0, key);
  assert.equal(summary.total_bytes, summary.protected_bytes + summary.reclaimable_bytes + summary.unknown_bytes);
  assert.equal(summary.policy.automatic_cleanup, false); report.storage_summary = summary;
  report.checks.push('live_storage_summary_readable_and_file_bytes_consistent');
  const manifest = await get(`/_next/static/${BUILD_ID}/_buildManifest.js`);
  assert.ok(/javascript/.test(manifest.type) && manifest.body.toString('utf8').includes('__BUILD_MANIFEST'));
  report.build_manifest_sha256 = manifest.hash; report.checks.push('expected_build_manifest_served');
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') report.console_errors.push(message.text()); });
  await page.goto(origin + '/', { waitUntil: 'networkidle' }); await page.getByRole('button', { name: '存储管理', exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready); await layout(page, 'desktop');
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.t1-sidebar').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '展开任务导航', exact: true }).click(); await page.getByRole('button', { name: '存储管理', exact: true }).waitFor();
  await layout(page, 'mobile');
  report.after_hashes = await hashes(); assert.deepEqual(report.after_hashes, report.before_hashes); report.checks.push('papers_runs_models_response_hashes_unchanged');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.blocked, []);
  assert.ok(report.request_log.every(item => ['GET', 'HEAD'].includes(item.method)));
  assert.ok(report.request_log.every(item => !/\/storage\/(?:preview|cleanup)$/.test(item.path)));
  report.checks.push('zero_page_errors_and_only_GET_HEAD_requests_no_preview_cleanup'); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally { report.finished_at = new Date().toISOString(); await browser.close(); await writeFile(join(evidence, 'live-readonly.json'), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify({ status: report.status, checks: report.checks, error: report.error, summary_phase: report.summary_phase, business_writes: report.production_business_writes, previews: report.preview_requests, cleanups: report.cleanup_requests }));
