/** Isolated task identity browser gate. No credentials, parser, or model is loaded. */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExtractionStore, RunStore } from '@t1/agent';
import { ContractError } from '@t1/contracts';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { buildApp } from '../src/app.js';
import { modelProfile } from '../src/workbench-models.js';

const directory = await mkdtemp(resolve('runtime-data/task-identity-ui-'));
const extraction = new ExtractionStore(resolve(directory, 'db.sqlite')), legacy = new RunStore(':memory:');
const workflow = new WorkbenchWorkflow(extraction, { sources: false, directory: resolve(directory, 'workbench'),
  runner: { controlled: true, provider: 'task-identity-browser-gate', model_id: 'no-model',
    default_model_profile: modelProfile('agicto', { model_id: 'gpt-6-luna', api: 'openai-responses', reasoning_effort: 'medium', context_window: 1050000, max_output_tokens: 8192 }, 'server'),
    execute: async () => { throw new Error('model_execution_forbidden'); } },
  parse: async (_input, _file, _directory, signal) => new Promise((_resolve, reject) => {
    const abort = () => reject(new ContractError('task_identity_browser_gate_closed'));
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  }) });
await workflow.initialize();
const seed = await workflow.upload(Buffer.from('%PDF-1.4\n% SOURCE IDENTITY\n%%EOF\n'), 'source-reference.pdf', 'Source identity untouched');
const app = buildApp(legacy, undefined, workflow);
await app.listen({ host: '127.0.0.1', port: 3216 });
await writeFile('runtime-data/agent-notes/task-identity-ui-runtime.json', JSON.stringify({ directory, pid: process.pid, port: 3216, seed_paper_id: seed.paper.id, controlled: true, paid_calls: 0 }) + '\n');
console.log('Isolated task identity browser gate ready on 3216');
let closing = false;
const close = async () => { if (closing) return; closing = true; await app.close(); legacy.close(); extraction.close(); };
process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close());
