/** Standalone engineering browser server. It never loads model configuration or credentials. */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExtractionStore, RunStore } from '@t1/agent';
import { ContractError } from '@t1/contracts';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { buildApp } from '../src/app.js';

const directory = await mkdtemp(resolve('runtime-data/batch-ui-'));
const extraction = new ExtractionStore(resolve(directory, 't1.sqlite')), legacy = new RunStore(resolve(directory, 't1.sqlite'));
const workflow = new WorkbenchWorkflow(extraction, { directory: resolve(directory, 'workbench'),
  runner: { controlled: true, provider: 'browser-engineering-gate', model_id: 'no-model', execute: async () => { throw new Error('model_execution_forbidden'); } },
  parse: async (_input, _file, _directory, signal) => new Promise((_resolve, reject) => {
    const finish = () => reject(new ContractError('browser_engineering_gate_cancelled'));
    signal.addEventListener('abort', finish, { once: true }); if (signal.aborted) finish();
  }) });
const app = buildApp(legacy, undefined, workflow);
await app.listen({ host: '127.0.0.1', port: 3211 });
await writeFile('runtime-data/agent-notes/batch-ui-runtime.json', JSON.stringify({ pid: process.pid, directory, port: 3211, controlled: true, model_calls: 0 }) + '\n');
console.log('Controlled browser fixture ready on 3211');
const shutdown = async () => { await app.close(); legacy.close(); extraction.close(); };
process.once('SIGTERM', () => void shutdown()); process.once('SIGINT', () => void shutdown());
