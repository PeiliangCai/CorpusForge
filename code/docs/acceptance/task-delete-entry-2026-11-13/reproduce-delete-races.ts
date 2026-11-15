/** Baseline-only deterministic reproduction. Isolated SQLite/files; no production mutation or provider calls. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import fs from 'node:fs/promises';
import { mock } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { ExtractionStore } from '@t1/agent';
import { WorkbenchWorkflow } from '../../../apps/server/src/workflow.js';
import { controlledFixture } from '../../../apps/server/test/controlled-fixture.js';

const errors: string[] = [];
process.on('unhandledRejection', error => { const message = error instanceof Error ? error.message : String(error); errors.push(message); console.log(JSON.stringify({ kind: 'unhandled_after_delete', message })); });
const replay = await controlledFixture({ delayMs: 1 });
const bytes = await readFile('evaluation/corpus/development-candidates/L05.pdf');
const root = await mkdtemp(resolve('runtime-data/delete-races-baseline-'));
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
try {
  {
    const store = new ExtractionStore(resolve(root, 'terminal.sqlite'));
    const entered = barrier(), finish = barrier();
    const workflow = new WorkbenchWorkflow(store, { sources: false, directory: resolve(root, 'terminal'), parse: replay.parse, discover: replay.discover,
      runner: { controlled: true, provider: 'deletion-race-fixture', model_id: 'no-model-call', execute: async context => {
        for (const state of ['extracting','reconciling','completed'] as const) context.store.transition(context.input.run_id, state);
        entered.release(); await finish.promise; return { summary: 'fixture finalization', coverage: { paid_requests: 0 } };
      } } });
    const paper = (await workflow.upload(bytes, 'terminal.pdf')).paper;
    const id = (await workflow.start(paper.id, workflow.scopeCatalog().default_scope)).run.run_id; await entered.promise;
    const before = (await workflow.runs(id))[0]!;
    const result = await workflow.deletePaper(paper.id);
    finish.release(); const settled = await Promise.allSettled([workflow.waitForIdle()]); await delay(25);
    console.log(JSON.stringify({ scenario: 'raw_terminal_but_active', public_state_before: before.state, result_ready_before: before.result_ready,
      deletion_accepted: result.deleted, runs_deleted: result.runs_deleted, coordinator_settlement: settled.map(value => value.status === 'rejected' ? { status: value.status, reason: value.reason instanceof Error ? value.reason.message : String(value.reason) } : { status: value.status }), remaining_papers: (await workflow.papers()).length }));
    await workflow.close(); store.close();
  }
  {
    const store = new ExtractionStore(resolve(root, 'preparing.sqlite'));
    const entered = barrier(), prepare = barrier();
    const workflow = new WorkbenchWorkflow(store, { ...replay, sources: false, directory: resolve(root, 'preparing'), runner: { ...replay.runner!,
      prepare: async () => { entered.release(); await prepare.promise; } } });
    const paper = (await workflow.upload(bytes, 'preparing.pdf')).paper;
    const pending = workflow.start(paper.id, workflow.scopeCatalog().default_scope); await entered.promise;
    const result = await workflow.deletePaper(paper.id); prepare.release(); const settled = await Promise.allSettled([pending]);
    console.log(JSON.stringify({ scenario: 'start_prepare_overlaps_delete', deletion_accepted: result.deleted,
      start_settlement: settled.map(value => value.status === 'rejected' ? { status: value.status, reason: value.reason instanceof Error ? value.reason.message : String(value.reason) } : { status: value.status }), remaining_runs: (await workflow.runs()).length, remaining_papers: (await workflow.papers()).length }));
    await workflow.close(); store.close();
  }
  {
    const store = new ExtractionStore(resolve(root, 'shared.sqlite'));
    const workflow = new WorkbenchWorkflow(store, { sources: false, directory: resolve(root, 'shared') });
    const paper = (await workflow.upload(bytes, 'shared-first.pdf')).paper;
    const row = JSON.parse(store.db.prepare('SELECT payload_json FROM workbench_papers WHERE id=?').get(paper.id)!.payload_json as string);
    const path = resolve(workflow.codeRoot, row.pdf.path), entered = barrier(), unlink = barrier(), nativeRm = fs.rm;
    const intercepted = mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]) === path) { entered.release(); await unlink.promise; }
      return nativeRm(...args);
    });
    syncBuiltinESMExports();
    try {
      const deleting = workflow.deletePaper(paper.id); await entered.promise;
      const duplicate = (await workflow.upload(bytes, 'shared-second.pdf')).paper;
      const referencedBeforeUnlink = (await workflow.pdf(duplicate.id)).length === bytes.length;
      unlink.release(); const deletion = await deleting;
      const read = await Promise.allSettled([workflow.pdf(duplicate.id)]);
      console.log(JSON.stringify({ scenario: 'same_sha_upload_overlaps_unlink', upload_committed_before_unlink: true, referenced_before_unlink: referencedBeforeUnlink,
        deleted_result_shared_pdf_retained: deletion.shared_pdf_retained, new_paper_source: read.map(value => value.status === 'rejected' ? { status: value.status, reason: value.reason instanceof Error ? value.reason.message : String(value.reason) } : { status: value.status }) }));
    } finally { unlink.release(); intercepted.mock.restore(); syncBuiltinESMExports(); await workflow.close(); store.close(); }
  }
  console.log(JSON.stringify({ isolated: true, paid_model_calls: 0, production_write_requests: 0, observed_unhandled: errors }));
} finally { await rm(root, { recursive: true, force: true }); }
