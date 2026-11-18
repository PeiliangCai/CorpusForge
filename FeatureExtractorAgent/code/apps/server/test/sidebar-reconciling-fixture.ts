/** Native reconciliation plus terminal finalization, using only saved local records. */
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { ExtractionStore, RunStore } from '@t1/agent';
import { ContractError } from '@t1/contracts';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { buildApp } from '../src/app.js';
import { controlledFixture } from './controlled-fixture.js';

const terminalState = process.env.T1_FINALIZING_STATE;
if (terminalState !== 'completed' && terminalState !== 'partial') throw new Error('fixture_terminal_state_required');
const directory = resolve(`runtime-data/sidebar-reconciling-${terminalState}-20261113`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const extraction = new ExtractionStore(resolve(directory, 't1.sqlite')), legacy = new RunStore(':memory:');
let nativePaused = false, parsePaused = false;
function gate(signal: AbortSignal) {
  return new Promise<never>((_resolve, reject) => {
    const finish = () => reject(new ContractError('reconciling_fixture_cancelled'));
    signal.addEventListener('abort', finish, { once: true }); if (signal.aborted) finish();
  });
}
const fixture = await controlledFixture({ delayMs: 1, pause: async (id, signal) => {
  if (!nativePaused) return;
  extraction.transition(id, 'reconciling'); await gate(signal);
} });
const parse = fixture.parse!;
fixture.parse = async (...args) => parsePaused ? gate(args[3]) : parse(...args);
const workflow = new WorkbenchWorkflow(extraction, { ...fixture, directory: resolve(directory, 'workbench') });
await workflow.initialize(); const scope = workflow.scopeCatalog().default_scope;
const saved = (await workflow.start('L01', scope, 'reconciling-saved', { kind: 'single' })).run.run_id;
await workflow.waitForIdle(); nativePaused = true;
const native = (await workflow.start('L01', scope, 'native-reconciling', { kind: 'single' })).run.run_id;
async function state(id: string, expected: string) {
  for (let i = 0; i < 100; i++) { if (extraction.snapshot(id).state === expected) return; await delay(20); }
  throw new Error(`fixture_state_timeout:${expected}`);
}
await state(native, 'reconciling'); nativePaused = false; parsePaused = true;
const finalizing = (await workflow.start('L02', scope, 'terminal-finalizing', { kind: 'single' })).run.run_id;
await state(finalizing, 'parsing');
for (const next of ['extracting', 'reconciling', terminalState] as const) extraction.transition(finalizing, next);
const app = buildApp(legacy, undefined, workflow); await app.listen({ host: '127.0.0.1', port: 3215 });
await writeFile(resolve(directory, 'runtime.json'), JSON.stringify({ pid: process.pid, port: 3215, directory, terminalState,
  runs: { saved, native, finalizing }, native_candidate_count: extraction.current(native).length, paid_model_calls: 0 }, null, 2) + '\n');
console.log(`Isolated native reconciliation / raw ${terminalState} fixture ready on 3215`);
const shutdown = async () => { await app.close(); legacy.close(); extraction.close(); };
process.once('SIGTERM', () => void shutdown()); process.once('SIGINT', () => void shutdown());
