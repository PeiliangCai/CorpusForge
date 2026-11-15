/** Isolated browser engineering fixture. No credentials, parser process or paid provider. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExtractionStore, RunStore } from '@t1/agent';
import { ContractError } from '@t1/contracts';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { modelProfile } from '../src/workbench-models.js';
import { buildApp } from '../src/app.js';
import { controlledFixture } from './controlled-fixture.js';

const directory = resolve(process.env.T1_MODEL_UI_FIXTURE_DIR ?? 'runtime-data/ui-model-switch-fixture');
await mkdir(directory, { recursive: true, mode: 0o700 });
const extraction = new ExtractionStore(resolve(directory, 't1.sqlite')), legacy = new RunStore(':memory:');
const fixture = await controlledFixture({ delayMs: 1 }); let paused = false;
const initial = modelProfile('agicto', { model_id: 'gpt-6-luna', api: 'openai-responses', reasoning_effort: 'medium', context_window: 1050000, max_output_tokens: 8192 }, 'server');
fixture.runner!.default_model_profile = initial;
const parse = fixture.parse!;
fixture.parse = async (...args) => {
  if (!paused) return parse(...args);
  const signal = args[3]; return new Promise((_resolve, reject) => {
    const finish = () => reject(new ContractError('model_ui_gate_cancelled'));
    signal.addEventListener('abort', finish, { once: true }); if (signal.aborted) finish();
  });
};
const workflow = new WorkbenchWorkflow(extraction, { ...fixture, directory: resolve(directory, 'workbench') });
await workflow.initialize();
const scope = workflow.scopeCatalog().default_scope;
if (!extraction.db.prepare("SELECT 1 FROM workbench_requests WHERE request_id='model-ui-seed-single'").get()) {
  await workflow.start('L01', scope, 'model-ui-seed-single', { kind: 'single' }, initial.profile_id); await workflow.waitForIdle();
}
paused = true;
if (!extraction.db.prepare("SELECT 1 FROM workbench_requests WHERE request_id='model-ui-seed-batch'").get())
  await workflow.start('L01', scope, 'model-ui-seed-batch', { kind: 'batch', batch_id: '7f42cde1-5c8e-4e88-a6c4-a5204f213c38' }, initial.profile_id);
const app = buildApp(legacy, undefined, workflow);
await app.listen({ host: '127.0.0.1', port: 3213 });
await writeFile(resolve(directory, 'runtime.json'), JSON.stringify({ pid: process.pid, directory, port: 3213, paid_model_calls: 0 }) + '\n');
console.log('Isolated UI model switch fixture ready on 3213');
const shutdown = async () => { await app.close(); legacy.close(); extraction.close(); };
process.once('SIGTERM', () => void shutdown()); process.once('SIGINT', () => void shutdown());
