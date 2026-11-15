import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { exportEvidenceDelivery, validateEvidenceSubmission } from '@t1/agent';
import { makeEvidenceFixture } from '../../../tests/extraction/fixtures/evidence-fixtures.js';
import { isT1ApiMethod, isT1ApiPath, t1BackendPath } from '../../pi-web/t1/gateway-policy.js';

test('retention mutations and retained downloads stay inside the explicit T1 method/path boundary', () => {
  const prefix = '/api/t1/workbench/runs/run:1';
  const retention = prefix + '/records/record:1/retention';
  assert.equal(isT1ApiPath(retention), true); assert.equal(isT1ApiMethod(retention, 'POST'), true);
  for (const method of ['GET', 'HEAD', 'PATCH', 'PUT', 'DELETE']) assert.equal(isT1ApiMethod(retention, method), false, method);
  for (const kind of ['retained_jsonl', 'retained_csv', 'retained_package', 'approved_jsonl']) {
    assert.equal(isT1ApiMethod(prefix + '/exports/' + kind, 'GET'), true); assert.equal(isT1ApiMethod(prefix + '/exports/' + kind, 'POST'), false);
  }
  assert.equal(t1BackendPath(['workbench', 'runs', 'run:1', 'records', 'record:1', 'retention']), '/api/workbench/runs/run%3A1/records/record%3A1/retention');
  for (const path of ['/api/t1/workbench/runs/run:1/records/../retention', prefix + '/exports/retained_other', '/api/agent/new']) assert.equal(isT1ApiPath(path), false);
});

test('retained export cannot bypass source glyph quarantine or create a directory before rejecting it', async () => {
  const fixture = makeEvidenceFixture(), result = validateEvidenceSubmission(fixture.submission, fixture.context); assert.ok(result.record);
  const versions = [{ record: result.record, version: 1, actor: 'automatic' as const, status: 'active' as const }];
  fixture.document.blocks[0]!.source_glyph_issues = [{ code: 'sparse_embedded_font_without_unicode_mapping', start: 0, end: 1,
    font_name: 'Custom', font_program_sha256: 'a'.repeat(64), pdf_character_code: 109, precision: 'glyph_offset' }];
  const directory = 'runtime-data/retained-glyph-guard-must-not-exist';
  await assert.rejects(exportEvidenceDelivery(fixture.document, versions, { codeRoot: '.', directory, mode: 'retained', coverage: {},
    retentionSelections: [{ record_id: result.record.record_id, record_version: 1, decision_record_version: 1, status: 'kept', revision: 0, origin: 'default' }] }), /source_glyph_fidelity_unverified/);
  await assert.rejects(access(directory), /ENOENT/);
});
