/** Isolated saved-development-source replay. No provider, credentials, parser or paid calls. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExtractionStore, RunStore } from '@t1/agent';
import type { EvidenceVersion } from '@t1/contracts';
import { WorkbenchSources } from '../src/workbench.js';
import { WorkbenchWorkflow, type WorkflowOptions } from '../src/workflow.js';
import { buildApp } from '../src/app.js';

export async function runIsolationFixture() {
  const directory = await mkdtemp(resolve('runtime-data/run-isolation-'));
  const store = new ExtractionStore(resolve(directory, 'fixture.sqlite')), legacy = new RunStore(':memory:');
  const seed = (await new WorkbenchSources().retained()).find(value => value.row.id === 'L05')!;
  assert.ok(seed);
  const replay = (seed.outputs[0]!.result.records as EvidenceVersion[]).filter((version, index, all) =>
    all.findIndex(other => JSON.stringify(other.record.quote_span.segments) === JSON.stringify(version.record.quote_span.segments)) === index);
  assert.ok(replay.length >= 3);
  const selections = [[0], [1, 2], []];
  let executions = 0;
  const options: WorkflowOptions = {
    directory: resolve(directory, 'workbench'), sources: false,
    parse: async (input, path) => {
      const document = structuredClone(seed.document);
      document.document_id = input.document_id; document.source.file_reference = path;
      for (const block of document.blocks) block.document_id = input.document_id;
      return document;
    },
    discover: async document => { const catalog = structuredClone(seed.catalog); catalog.document_id = document.document_id; return catalog; },
    runner: { controlled: true, provider: 'controlled-local-replay', model_id: 'saved-development-records-no-model', execute: async context => {
      const indices = selections[executions++] ?? [];
      context.store.transition(context.input.run_id, 'extracting');
      context.store.event(context.input.run_id, 'controlled_fixture', { paid_requests: 0, replay_only: true });
      for (const [position, index] of indices.entries()) {
        const record = structuredClone(replay[index]!.record);
        // The first candidate deliberately has the same id in both runs. The
        // composite run/record identity must still keep content and retention apart.
        record.record_id = position === 0 ? 'replay-shared-record' : `replay-record-${index}`;
        record.document_id = context.input.document_id; record.article_family_id = context.metadata.article_family_id;
        record.source_version = structuredClone(context.metadata.source_version);
        Object.assign(record.extraction_trace, { task_id: context.metadata.task_id, run_id: context.input.run_id,
          scope: structuredClone(context.input.scope), catalog_version: context.input.scope.catalog_version,
          provider: 'controlled-local-replay', model_id: 'saved-development-records-no-model' });
        Object.assign(record.extraction_trace.source_binding, { task_id: context.metadata.task_id, run_id: context.input.run_id,
          document_id: context.input.document_id, source_version: context.metadata.source_version.version });
        record.review_status = 'pending'; record.review_events = []; record.handoff_status = 'candidate_only'; record.duplicate_and_conflict_links = [];
        context.store.apply(context.input.run_id, { action: 'insert', record, expected_version: null, target_record_id: null, related_record_ids: [], issues: [],
          changes: [{ kind: 'insert', record_id: record.record_id, expected_version: null, record }] });
      }
      context.store.transition(context.input.run_id, 'reconciling'); context.store.transition(context.input.run_id, 'completed');
      return { summary: `Controlled replay: ${indices.length} records; no model called.`, coverage: { controlled_saved_source_replay: true, new_model_requests: 0 } };
    } },
  };
  const workflow = new WorkbenchWorkflow(store, options), app = buildApp(legacy, undefined, workflow);
  await app.ready();
  const pdf = await readFile(seed.row.pdf.path), paper = (await workflow.upload(pdf, 'same-paper.pdf')).paper;
  const repeated = await workflow.upload(pdf, 'renamed-same-paper.pdf'); assert.equal(repeated.paper.id, paper.id);
  const ids: Record<string, string> = {};
  for (const name of ['older', 'newer', 'empty']) {
    ids[name] = (await workflow.start(paper.id, workflow.scopeCatalog().default_scope, 'isolation-' + name, { kind: 'single' }, undefined, `Replay ${name}`)).run.run_id;
    await workflow.waitForIdle();
  }
  const close = async () => { await app.close(); legacy.close(); store.close(); await rm(directory, { recursive: true, force: true }); };
  return { directory, store, legacy, workflow, app, paper, ids, close, paid_calls: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fixture = await runIsolationFixture();
  const port = Number(process.env.T1_RUN_ISOLATION_PORT ?? '3216');
  await fixture.app.listen({ host: '127.0.0.1', port });
  await writeFile('runtime-data/agent-notes/run-isolation-runtime.json', JSON.stringify({ directory: fixture.directory, pid: process.pid,
    port, paper_id: fixture.paper.id, ids: fixture.ids, controlled: true, paid_calls: 0 }) + '\n');
  console.log(`No-model isolated run fixture ready on ${port}`);
  process.once('SIGTERM', () => void fixture.close()); process.once('SIGINT', () => void fixture.close());
}
