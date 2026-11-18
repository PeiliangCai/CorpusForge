/** One isolated browser fixture; saved-source replay only, no credentials or paid model. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExtractionStore, RunStore } from '@t1/agent';
import { ContractError } from '@t1/contracts';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { modelProfile } from '../src/workbench-models.js';
import { buildApp } from '../src/app.js';
import { controlledFixture } from './controlled-fixture.js';
const directory = resolve(process.env.T1_TASK_RECORDS_FIXTURE_DIR ?? 'runtime-data/task-records-fixture-20261113');
await mkdir(directory, { recursive: true, mode: 0o700 });
const store = new ExtractionStore(resolve(directory, 'fixture.sqlite')), legacy = new RunStore(':memory:');
const fixture = await controlledFixture({ delayMs: 1 }), parse = fixture.parse!, execute = fixture.runner!.execute;
const profile = modelProfile('agicto', { model_id: 'gpt-6-luna', api: 'openai-responses', reasoning_effort: 'medium', context_window: 1050000, max_output_tokens: 8192 }, 'server');
fixture.runner!.default_model_profile = profile;
const paused = new Set<string>(); let finishingPaper = '', finish!: () => void;
fixture.parse = async (...args) => {
  if (!paused.has(args[0].document_id)) return parse(...args);
  return new Promise((_resolve, reject) => { const signal = args[3], abort = () => reject(new ContractError('fixture_parser_cancelled')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
};
fixture.runner!.execute = async context => {
  const result = await execute(context);
  if (context.input.document_id === finishingPaper) await new Promise<void>(resolve => { finish = resolve; context.signal.addEventListener('abort', resolve as () => void, { once: true }); });
  return result;
};
const workflow = new WorkbenchWorkflow(store, { ...fixture, directory: resolve(directory, 'workbench') }); await workflow.initialize();
const scope = workflow.scopeCatalog().default_scope, bytes = await readFile('evaluation/corpus/development-candidates/L01.pdf');
const currentPaper = (await workflow.upload(bytes, 'repeat.pdf', '同一论文 · 两次独立抽取')).paper;
const lastPaper = (await workflow.upload(bytes, 'last.pdf', '仅一次抽取 · 删除验证')).paper;
const uploadOnly = (await workflow.upload(bytes, 'upload-only.pdf', '仅上传 · 尚未提交')).paper;
const activePaper = (await workflow.upload(bytes, 'active.pdf', '运行与收尾 · 删除保护')).paper;
const ids: Record<string, string> = {};
for (const [label, paper] of [['older', currentPaper], ['spare', currentPaper], ['current', currentPaper], ['last', lastPaper]] as const) { ids[label] = (await workflow.start(paper.id, scope, 'fixture-' + label, { kind: 'single' }, profile.profile_id)).run.run_id; await workflow.waitForIdle(); }
const batchId = '1dc9a538-88ab-4537-a1f3-c72fe778a911';
for (const [label, paperId] of [['batchA', 'L01'], ['batchB', 'L02']] as const) { ids[label] = (await workflow.start(paperId, scope, 'fixture-' + label, { kind: 'batch', batch_id: batchId }, profile.profile_id)).run.run_id; await workflow.waitForIdle(); }
const terminalPaper = (await workflow.upload(bytes, 'finishing.pdf', '完成后保存 · 删除保护')).paper; finishingPaper = terminalPaper.id;
ids.finishing = (await workflow.start(terminalPaper.id, scope, 'fixture-finishing', { kind: 'single' }, profile.profile_id)).run.run_id;
for (let i = 0; i < 200 && store.snapshot(ids.finishing).state !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 10));
paused.add(activePaper.id); ids.active = (await workflow.start(activePaper.id, scope, 'fixture-active', { kind: 'single' }, profile.profile_id)).run.run_id;
const app = buildApp(legacy, undefined, workflow);
app.post('/__fixture/release-finishing', async () => { finish?.(); return { released: true }; });
const requests: Array<{ method: string; path: string }> = [];
app.addHook('onRequest', async request => { if (!['GET', 'HEAD'].includes(request.method)) requests.push({ method: request.method, path: request.url }); });
app.get('/__fixture/requests', async () => ({ requests, paid_model_calls: 0 }));
await app.listen({ host: '127.0.0.1', port: 3215 });
await writeFile(resolve(directory, 'runtime.json'), JSON.stringify({ pid: process.pid, port: 3215, ids, papers: { current: currentPaper.id, last: lastPaper.id, active: activePaper.id, finishing: terminalPaper.id, uploadOnly: uploadOnly.id }, batchId, paid_model_calls: 0 }, null, 2));
console.log('Isolated task records fixture ready on 3215');
const shutdown = async () => { finish?.(); await app.close(); legacy.close(); store.close(); };
process.once('SIGTERM', () => void shutdown()); process.once('SIGINT', () => void shutdown());
