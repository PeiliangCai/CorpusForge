/** Isolated browser engineering gate. No provider configuration, secrets, parser or paid model is loaded. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExtractionStore, RunStore } from '@t1/agent';
import { ContractError } from '@t1/contracts';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { buildApp } from '../src/app.js';

const directory = resolve('runtime-data/folder-task-types-fixture');
await mkdir(directory, { recursive: true, mode: 0o700 });
const extraction = new ExtractionStore(resolve(directory, 't1.sqlite')), legacy = new RunStore(resolve(directory, 't1.sqlite'));
const workflow = new WorkbenchWorkflow(extraction, { directory: resolve(directory, 'workbench'),
  runner: { controlled: true, provider: 'folder-task-types-gate', model_id: 'no-model', execute: async () => { throw new Error('model_execution_forbidden'); } },
  parse: async (_input, _file, _directory, signal) => new Promise((_resolve, reject) => {
    const finish = () => reject(new ContractError('folder_task_types_gate_cancelled'));
    signal.addEventListener('abort', finish, { once: true }); if (signal.aborted) finish();
  }) });
const app = buildApp(legacy, undefined, workflow);
await app.listen({ host: '127.0.0.1', port: 3212 });
await writeFile('runtime-data/agent-notes/folder-task-types-fixture.json', JSON.stringify({ pid: process.pid, directory, port: 3212, controlled: true, model_calls: 0 }) + '\n');
console.log('Folder task types controlled browser fixture ready on 3212');
const shutdown = async () => { await app.close(); legacy.close(); extraction.close(); };
process.once('SIGTERM', () => void shutdown()); process.once('SIGINT', () => void shutdown());
