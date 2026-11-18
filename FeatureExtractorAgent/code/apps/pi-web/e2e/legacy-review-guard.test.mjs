import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertLegacyReviewCapabilities, requireLegacyReviewWorkflow } from './legacy-review-guard.mjs';

test('historical scripts refuse the new retention capability and unavailable capabilities before subsequent actions', async () => {
  let subsequentAction = false;
  await assert.rejects(async () => {
    await requireLegacyReviewWorkflow('http://127.0.0.1:30141', 'historical-test', async (url, init) => {
      assert.equal(url.pathname, '/api/t1/workbench/capabilities'); assert.equal(init.method, 'GET');
      return { ok: true, json: async () => ({ persisted_retention: true }) };
    });
    subsequentAction = true;
  }, /historical individual-approval UI.*retention-workflow/s);
  assert.equal(subsequentAction, false);
  await assert.rejects(requireLegacyReviewWorkflow('http://127.0.0.1:30141', 'historical-test', async () => ({ ok: false, status: 503 })), /refusing to start/);
  assert.doesNotThrow(() => assertLegacyReviewCapabilities({ persisted_review: true }, 'legacy-fixture'));
});

test('both historical script entries check capabilities before browser launch or evidence writes', async () => {
  for (const script of ['t1-workflow.mjs', 'results-presentation.mjs']) {
    const source = await readFile(new URL(script, import.meta.url), 'utf8'), guard = source.indexOf('await requireLegacyReviewWorkflow(');
    assert.ok(guard >= 0); assert.ok(guard < source.indexOf('await chromium.launch(')); assert.ok(guard < source.indexOf('await mkdir('));
  }
});
