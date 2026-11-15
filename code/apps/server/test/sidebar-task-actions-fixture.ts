/** Isolated task menu fixture: real workflow cancellation, no parser process or paid provider. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExtractionStore, RunStore } from '@t1/agent';
import { ContractError } from '@t1/contracts';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { buildApp } from '../src/app.js';
import { controlledFixture } from './controlled-fixture.js';

const directory = resolve(process.env.T1_TASK_ACTIONS_FIXTURE_DIR ?? 'runtime-data/sidebar-task-actions-fixture');
await mkdir(directory, { recursive: true, mode: 0o700 });
const extraction = new ExtractionStore(resolve(directory, 't1.sqlite')), legacy = new RunStore(':memory:');
const fixture = await controlledFixture({ delayMs: 1 });
const parse = fixture.parse!; let paused = false;
fixture.parse = async (...args) => {
  if (!paused) return parse(...args);
  const signal = args[3];
  return new Promise((_resolve, reject) => {
    const finish = () => reject(new ContractError('task_actions_fixture_cancelled'));
    signal.addEventListener('abort', finish, { once: true }); if (signal.aborted) finish();
  });
};
const workflow = new WorkbenchWorkflow(extraction, { ...fixture, directory: resolve(directory, 'workbench') });
await workflow.initialize();
const scope = workflow.scopeCatalog().default_scope;
const saved = (await workflow.start('L01', scope, 'actions-saved', { kind: 'single' })).run.run_id;
await workflow.waitForIdle(); paused = true;
const parsing = (await workflow.start('L01', scope, 'actions-parsing', { kind: 'batch', batch_id: 'b3c76d09-76bd-48d6-924a-ddc215ff389c' })).run.run_id;
const finishing = (await workflow.start('L02', scope, 'actions-finishing', { kind: 'single' })).run.run_id;
const queued = (await workflow.start('L01', scope, 'actions-queued', { kind: 'single' })).run.run_id;
const secondQueued = (await workflow.start('L01', scope, 'actions-second-queued', { kind: 'single' })).run.run_id;
const race = (await workflow.start('L05', scope, 'actions-race', { kind: 'single' })).run.run_id;
const retry = (await workflow.start('L07', scope, 'actions-retry', { kind: 'single' })).run.run_id;
const app = buildApp(legacy, undefined, workflow);
app.addHook('onRequest', async request => {
  // Reproduce finalization starting after the menu opened, before cancel().
  if (request.method === 'POST' && request.url === `/api/workbench/runs/${finishing}/cancel` && extraction.snapshot(finishing).state === 'parsing') {
    for (const state of ['extracting', 'reconciling', 'completed'] as const) extraction.transition(finishing, state);
  }
  if (request.method === 'POST' && request.url === `/api/workbench/runs/${race}/cancel` && extraction.snapshot(race).state === 'queued') {
    for (const state of ['parsing', 'extracting', 'reconciling', 'completed'] as const) extraction.transition(race, state);
    extraction.db.prepare("UPDATE workbench_runs SET payload_json=json_set(payload_json,'$.finished_at',?) WHERE id=?").run(new Date().toISOString(), race);
  }
});
await app.listen({ host: '127.0.0.1', port: 3214 });
await writeFile(resolve(directory, 'runtime.json'), JSON.stringify({ pid: process.pid, directory, port: 3214, paid_model_calls: 0,
  runs: { saved, parsing, finishing, queued, secondQueued, race, retry } }, null, 2) + '\n');
console.log('Isolated sidebar task actions fixture ready on 3214');
const shutdown = async () => { await app.close(); legacy.close(); extraction.close(); };
process.once('SIGTERM', () => void shutdown()); process.once('SIGINT', () => void shutdown());
