import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExtractionStore, RunStore, ExtractionBudget, evidenceScopeIssues, matchEvidenceScope, validateEvidenceSubmission } from '@t1/agent';
import { scopeCatalogConfigIssues, type ScopeCatalogConfig } from '@t1/contracts';
import { decodeScopeCatalog, readScopeCatalog, MAX_SCOPE_CATALOG_BYTES } from '../src/catalog-config.js';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { executeWorkbenchExtraction } from '../src/workflow-runner.js';
import { buildApp } from '../src/app.js';
import { makeEvidenceFixture } from '../../../tests/extraction/fixtures/evidence-fixtures.js';
import { createRuntimeResponsesFixture } from '../../../tests/extraction/fixtures/runtime-responses.js';
import { controlledFixture } from './controlled-fixture.js';
const config = (): ScopeCatalogConfig => ({ schema_version: 'scope-catalog-1',
  cancers: [{ id: 'A', name: 'ENGINEERING A', aliases: ['Engineering Alpha'], image_type_ids: ['X'] }, { id: 'B', name: 'ENGINEERING B', image_type_ids: ['Y'] }],
  image_types: [{ id: 'X', name: 'ENGINEERING X' }, { id: 'Y', name: 'ENGINEERING Y' }] });
const decode = (value: unknown) => decodeScopeCatalog(Buffer.from(JSON.stringify(value)));
const until = async (condition: () => boolean) => { for (let index = 0; index < 300; index++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('scope_fixture_timeout'); };

test('one bounded operator JSON accepts add/edit/delete and optional aliases without medical approval', async () => {
  const directory = await mkdtemp(resolve('runtime-data/scope-config-'));
  try {
    await mkdir(resolve(directory, 'config'));
    const path = resolve(directory, 'config/scope-catalog.json'), original = config();
    await writeFile(path, JSON.stringify(original)); const first = readScopeCatalog(directory);
    assert.equal(first.catalog.status, 'operator_configured'); assert.equal(first.catalog.fixture, false);
    assert.deepEqual(first.catalog.features, []); assert.deepEqual(first.catalog.bindings, []);
    const changed = config(); changed.cancers[0]!.name = 'RENAMED A'; changed.cancers[0]!.description = 'Optional operator note'; changed.cancers[0]!.image_type_ids = ['Y'];
    changed.cancers.push({ id: 'C', name: 'ADDED C', image_type_ids: ['X'] }); changed.cancers.splice(1, 1);
    await writeFile(path, JSON.stringify(changed)); const second = readScopeCatalog(directory);
    assert.notEqual(first.catalog.catalog_version, second.catalog.catalog_version); assert.deepEqual(second.config, changed);
    assert.equal(second.catalog.image_types.find(entry => entry.id === 'Y')!.cancer_ids[0], 'A');
    assert.equal(second.catalog.cancers[0]!.description, 'Optional operator note');
    second.catalog.cancers[0]!.name = 'MUTATED COPY'; assert.equal(readScopeCatalog(directory).catalog.cancers[0]!.name, 'RENAMED A');
    await writeFile(path, '{broken'); assert.throws(() => readScopeCatalog(directory), /scope_catalog_json_invalid/);
    await rm(path); assert.throws(() => readScopeCatalog(directory), /^ContractError: scope_catalog_unavailable$/);
    assert.throws(() => decodeScopeCatalog(Buffer.from([0xc0, 0xaf])), /scope_catalog_json_invalid/);
    assert.throws(() => decodeScopeCatalog(Buffer.alloc(MAX_SCOPE_CATALOG_BYTES + 1)), /scope_catalog_too_large/);
    const actual = readScopeCatalog(); assert.deepEqual(scopeCatalogConfigIssues(actual.config), []);
    assert.ok(!('sources' in actual.config)); assert.ok(!('features' in actual.config));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('structural checks reject duplicates, dangling modality IDs and obsolete fields without fixing input', () => {
  for (const mutate of [(value: ScopeCatalogConfig) => { value.cancers[1]!.id = 'A'; },
    (value: ScopeCatalogConfig) => { value.cancers[0]!.image_type_ids.push('missing'); },
    (value: ScopeCatalogConfig) => { value.image_types[0]!.id = 'A'; },
    (value: ScopeCatalogConfig) => { value.cancers[0]!.name = '  '; }]) {
    const value = config(); mutate(value); const before = structuredClone(value);
    assert.ok(scopeCatalogConfigIssues(value).length); assert.deepEqual(value, before);
  }
  assert.throws(() => decode({ ...config(), features: [] }), /scope_catalog_invalid/);
  assert.throws(() => decode({ ...config(), status: 'approved' }), /scope_catalog_invalid/);
});

test('operator cancer/modality matching is exact, source grounded and feature vocabulary stays open', () => {
  const fixture = makeEvidenceFixture(['Engineering Alpha has an entirely new appearance on ENGINEERING X.']);
  const catalog = decode(config()).catalog; fixture.input.scope.catalog_version = catalog.catalog_version;
  fixture.input.scope.cancers = { mode: 'selected', ids: ['A'] }; fixture.input.scope.image_types = { mode: 'selected', ids: ['X'] };
  fixture.submission.disease_or_lesion.value = 'Engineering Alpha'; fixture.submission.modality.value = 'ENGINEERING X';
  fixture.submission.feature_name_raw = 'entirely new appearance'; fixture.submission.display_joiner = '\n';
  const context = { ...fixture.context, catalog };
  const result = validateEvidenceSubmission(fixture.submission, context);
  assert.equal(result.accepted, true, JSON.stringify(result.issues)); assert.deepEqual(result.record!.normalized_terms, []);
  assert.equal(result.record!.extraction_trace.catalog_status, 'operator_configured'); assert.equal(result.record!.evidence_validation.medical_semantics_verified, false);
  assert.equal(result.record!.original_quote, fixture.document.blocks[0]!.text);
  assert.deepEqual(evidenceScopeIssues(fixture.input.scope, catalog), []);
  assert.ok(evidenceScopeIssues({ ...fixture.input.scope, cancers: { mode: 'selected', ids: [] } }, catalog).includes('cancers_selected_empty'));
  assert.ok(evidenceScopeIssues({ ...fixture.input.scope, image_types: { mode: 'selected', ids: ['Y'] } }, catalog).some(code => code.includes('inapplicable')));
  assert.ok(evidenceScopeIssues({ ...fixture.input.scope, features: { mode: 'selected', binding_ids: ['old'] } }, catalog).includes('feature_scope_removed'));
  assert.equal(validateEvidenceSubmission({ ...fixture.submission, feature_binding_id: 'old' }, context).accepted, false);
  const unknown = { ...fixture.submission, disease_or_lesion: { value: null, status: 'unknown' as const, evidence: [] } };
  assert.equal(validateEvidenceSubmission(unknown, context).scope_match.status, 'needs_context');
  const multi = { ...fixture.input.scope, cancers: { mode: 'selected' as const, ids: ['A', 'B'] }, image_types: { mode: 'selected' as const, ids: ['X', 'Y'] } };
  const crossed = { ...fixture.submission, modality: { value: 'ENGINEERING Y', status: 'source_observed' as const, evidence: [{ block_id: 'fixture', exact_quote: 'ENGINEERING Y' }] } };
  assert.equal(matchEvidenceScope(crossed, multi, catalog).status, 'out_of_scope');
  assert.equal(matchEvidenceScope(crossed, { ...multi, cancers: { mode: 'all', ids: [] } }, catalog).status, 'in_scope');
  assert.equal(matchEvidenceScope(crossed, { ...multi, image_types: { mode: 'all', ids: [] } }, catalog).status, 'in_scope');
});

test('GET is live; admission, queue, batch retries, revisions, restart and idempotent replay keep server snapshots', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(resolve('runtime-data/scope-workflow-')), database = resolve(directory, 'fixture.sqlite');
  await mkdir(resolve(directory, 'config')); const path = resolve(directory, 'config/scope-catalog.json'); await writeFile(path, JSON.stringify(config()));
  let store = new ExtractionStore(database), legacy = new RunStore(':memory:');
  const entered = new Map<string, string>(), releases = new Map<string, () => void>();
  const fixture = await controlledFixture({ delayMs: 1, pause: (id, signal) => new Promise<void>(accept => { releases.set(id, accept); signal.addEventListener('abort', () => accept(), { once: true }); }) });
  const execute = fixture.runner!.execute; fixture.runner!.execute = async context => { entered.set(context.input.run_id, context.evidence_catalog!.catalog_version); return execute(context); };
  let workflow = new WorkbenchWorkflow(store, { directory, ...fixture, catalogProvider: () => readScopeCatalog(directory).catalog }), app = buildApp(legacy, undefined, workflow);
  const batch = { kind: 'batch' as const, batch_id: randomUUID() };
  try {
    await app.ready(); const initial = (await app.inject('/api/workbench/catalog')).json(), scope = initial.default_scope;
    const first = (await workflow.start('L01', scope, 'scope-batch-first', batch)).run;
    const second = (await workflow.start('L01', scope)).run;
    await until(() => entered.has(first.run_id) && entered.has(second.run_id));
    const queued = (await workflow.start('L01', scope)).run;
    const changed = config(); changed.cancers[0]!.name = 'RENAMED'; await writeFile(path, JSON.stringify(changed));
    const current = (await app.inject('/api/workbench/catalog')).json(); assert.notEqual(current.catalog_version, initial.catalog_version);
    const stale = await app.inject({ method: 'POST', url: '/api/workbench/papers/L04/runs', payload: { scope } }); assert.equal(stale.statusCode, 409);
    const oldFeature = await app.inject({ method: 'POST', url: '/api/workbench/papers/L04/runs', payload: { scope: { ...current.default_scope, features: { mode: 'selected', binding_ids: ['old'] } } } });
    assert.equal(oldFeature.statusCode, 400); assert.equal(oldFeature.json().error, 'feature_scope_removed');
    const sameBatch = (await workflow.start('L01', scope, 'scope-batch-next', batch)).run;
    assert.equal(sameBatch.scope_catalog!.catalog_version, initial.catalog_version);
    await assert.rejects(workflow.start('L05', current.default_scope, undefined, batch), /batch_scope_frozen/);
    const fresh = (await workflow.start('L01', current.default_scope)).run; assert.equal(fresh.scope_catalog!.catalog_version, current.catalog_version);
    await writeFile(path, '{bad');
    assert.equal((await app.inject('/api/workbench/catalog')).statusCode, 400);
    assert.equal((await workflow.start('L01', scope, 'scope-batch-first', batch)).run.run_id, first.run_id);
    for (const id of [first.run_id, second.run_id, queued.run_id, sameBatch.run_id, fresh.run_id]) {
      await until(() => entered.has(id) && releases.has(id)); assert.equal(entered.get(id), id === fresh.run_id ? current.catalog_version : initial.catalog_version); releases.get(id)!();
    }
    await workflow.waitForIdle();
    const before = await workflow.runDetail(first.run_id); assert.equal(before.output.scope_catalog!.cancers[0]!.name, 'ENGINEERING A');
    const record = before.output.records[0]!; const revision = await workflow.revise(first.run_id, record.id, { expected_version: record.version, source_unit_ids: record.source_unit_ids, reviewer: 'engineering-snapshot-test' });
    assert.ok(revision.record.fragments.length);
    await app.close(); store.close(); legacy.close();
    store = new ExtractionStore(database); legacy = new RunStore(':memory:');
    workflow = new WorkbenchWorkflow(store, { directory, ...fixture, catalogProvider: () => readScopeCatalog(directory).catalog }); app = buildApp(legacy, undefined, workflow); await app.ready();
    assert.equal((await workflow.runDetail(first.run_id)).output.scope_catalog!.catalog_version, initial.catalog_version);
    assert.equal((await workflow.start('L01', scope, 'scope-batch-first', batch)).run.run_id, first.run_id);
    const later = (await workflow.start('L01', scope, 'scope-batch-after-restart', batch)).run; await until(() => entered.has(later.run_id) && releases.has(later.run_id)); releases.get(later.run_id)!(); await workflow.waitForIdle();
    await workflow.deleteRun(first.run_id);
    await assert.rejects(workflow.start('L01', scope, 'scope-batch-first', batch), /submission_result_deleted/);
  } finally { for (const release of releases.values()) release(); await app.close(); store.close(); legacy.close(); await rm(directory, { recursive: true, force: true }); }
});

test('concurrent first batch members cannot establish different scope snapshots', async () => {
  const directory = await mkdtemp(resolve('runtime-data/scope-concurrent-')), store = new ExtractionStore(':memory:');
  const workflow = new WorkbenchWorkflow(store, { directory, sources: false, catalogProvider: () => decode(config()).catalog,
    runner: { controlled: true, provider: 'batch-gate', model_id: 'no-model', prepare: () => new Promise(resolve => setTimeout(resolve, 20)), execute: async () => { throw new Error('no provider'); } },
    parse: async () => { throw new Error('controlled parser gate'); } });
  try {
    const paper = (await workflow.upload(Buffer.from('%PDF-1.4\n% ENGINEERING STUB\n%%EOF\n'), 'gate.pdf')).paper;
    const scope = workflow.scopeCatalog().default_scope, batch = { kind: 'batch' as const, batch_id: randomUUID() };
    const outcomes = await Promise.allSettled([workflow.start(paper.id, scope, 'concurrent-scope-first', batch),
      workflow.start(paper.id, { ...scope, cancers: { mode: 'selected', ids: ['A'] } }, 'concurrent-scope-other', batch)]);
    assert.equal(outcomes[0]!.status, 'fulfilled'); assert.equal(outcomes[1]!.status, 'rejected');
    if (outcomes[1]!.status === 'rejected') assert.match(String(outcomes[1]!.reason), /batch_scope_frozen/);
    assert.equal((await workflow.runs()).length, 1);
  } finally { await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('installed Pi product helper receives operator catalog on loopback with an open new feature', async () => {
  const directory = await mkdtemp(resolve('runtime-data/scope-pi-')), store = new ExtractionStore(':memory:');
  const fixture = makeEvidenceFixture(['A synthetic lesion has an entirely new appearance.']);
  const catalog = decode(config()).catalog; fixture.input.scope.catalog_version = catalog.catalog_version;
  fixture.submission.feature_name_raw = 'entirely new appearance'; fixture.submission.display_joiner = '\n';
  fixture.submission.disease_or_lesion = { value: null, status: 'unknown', evidence: [] }; fixture.submission.modality = { value: null, status: 'unknown', evidence: [] };
  store.create(fixture.input, fixture.context.metadata);
  const local = await createRuntimeResponsesFixture([
    { calls: [{ name: 'read_document_blocks', arguments: {} }] },
    { calls: [{ name: 'submit_candidate_records', arguments: { records: [{ source_line_indices: [0], feature_name_raw: 'entirely new appearance', feature_category: 'appearance', evidence_type: 'imaging_observation', assertion: 'affirmed', origin: 'study_authors' }], batch_complete: true } }] },
    { calls: [{ name: 'get_document_context', arguments: {} }, { name: 'submit_candidate_records', arguments: { summary: 'Engineering open feature only.', reviews: [], links: [], updates: [], summary_complete: true } }] },
  ], { summaryAssessments: () => store.current(fixture.input.run_id).map(value => ({ record_id: value.record.record_id, expected_version: value.version, issue_codes: [], primary_assessment: 'uncertain' as const })) });
  try {
    const result = await executeWorkbenchExtraction({ input: fixture.input, document: fixture.document, evidence_catalog: catalog,
      directory, store, metadata: fixture.context.metadata, signal: new AbortController().signal }, local.config,
      new ExtractionBudget(resolve(directory, 'loopback-ledger.json'), local.endpoint), 30_000, true);
    assert.equal(result.coverage.whole_document_summary_complete, true); assert.equal(local.requests.length, 3);
    assert.equal(store.snapshot(fixture.input.run_id).state, 'completed'); assert.equal(store.current(fixture.input.run_id).length, 1);
    assert.equal(store.current(fixture.input.run_id)[0]!.record.extraction_trace.catalog_status, 'operator_configured');
    assert.deepEqual(store.current(fixture.input.run_id)[0]!.record.normalized_terms, []);
  } finally { await local.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
