import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sdkErrorDiagnostic } from '../../packages/agent/src/extraction-sdk-diagnostic.js';
import { createExtractionSession, developmentProfile, promptExtractionSession } from '../../packages/agent/src/extraction-pi.js';
import { ExtractionBudget } from '../../packages/agent/src/extraction-budget.js';
import { ModelConfig } from '../../packages/agent/src/config.js';

test('SDK diagnostic removes exact and encoded configured secrets before truncation', () => {
  const secret = 'offline-only-$credential?value=7';
  const raw = 'x '.repeat(250) + secret + '\n' + encodeURIComponent(secret);
  const diagnostic = sdkErrorDiagnostic(raw, [secret]);
  assert.ok(!diagnostic.sdk_error_message.includes(secret));
  assert.ok(!diagnostic.sdk_error_message.includes('offline-only-'));
  assert.ok(!diagnostic.sdk_error_message.includes(encodeURIComponent(secret)));
  assert.ok([...diagnostic.sdk_error_message].length <= 512);
});

test('SDK diagnostic removes headers, quoted credentials, URL userinfo and query tokens', () => {
  const raw = 'APIError: synthetic failure\nAuthorization: Bearer hidden-header-value\n' +
    '"api_key": "hidden-api-value", token=hidden-token; password is hidden-password; ' +
    'https://private-user:private-pass@fixture.invalid/v1?signature=hidden-query#hidden-fragment';
  const diagnostic = sdkErrorDiagnostic(raw);
  assert.match(diagnostic.sdk_error_message, /synthetic failure/);
  for (const secret of ['hidden-', 'private-user', 'private-pass', 'fixture.invalid', 'signature=hidden']) {
    assert.ok(!diagnostic.sdk_error_message.includes(secret));
  }
  assert.equal(diagnostic.sdk_error_type_hint, 'APIError');
});

test('SDK diagnostic removes token patterns and bounds Unicode without inventing exception type', () => {
  const diagnostic = sdkErrorDiagnostic('synthetic failure Basic dXNlcjpwYXNz ' +
    'sk-offlineonly123456789 eyJhbGciOiJub25l.eyJ0ZXN0Ijp0cnVlfQ.signatureoffline ' + '界'.repeat(900));
  assert.ok(!/dXNlcj|sk-offline|eyJhbGci|signatureoffline/u.test(diagnostic.sdk_error_message));
  assert.equal([...diagnostic.sdk_error_message].length, 512);
  assert.equal(diagnostic.sdk_error_message_truncated, true);
  assert.equal(diagnostic.sdk_error_type_hint, 'unknown');
  assert.ok(!diagnostic.sdk_error_message.includes('\ufffd'));
});

test('SDK diagnostic retains a useful bounded error and strips control characters', () => {
  const diagnostic = sdkErrorDiagnostic('SyntaxError: malformed synthetic event\u0000\u001b');
  assert.equal(diagnostic.sdk_error_message, 'SyntaxError: malformed synthetic event');
  assert.equal(diagnostic.sdk_error_message_truncated, false);
  assert.equal(diagnostic.sdk_error_type_hint, 'SyntaxError');
});

test('SDK diagnostic omits echoed prompt/response fields and distinguishes exact length boundary', () => {
  const diagnostic = sdkErrorDiagnostic('synthetic validation failure; prompt="PRIVATE_SYNTHETIC_DOCUMENT"; response={"private":"BODY"}');
  assert.match(diagnostic.sdk_error_message, /synthetic validation failure/);
  assert.ok(!/PRIVATE_SYNTHETIC_DOCUMENT|BODY/u.test(diagnostic.sdk_error_message));
  assert.equal(sdkErrorDiagnostic('x '.repeat(256)).sdk_error_message_truncated, false);
  const longer = sdkErrorDiagnostic('x '.repeat(256) + '界');
  assert.equal(longer.sdk_error_message.length, 512);
  assert.equal(longer.sdk_error_message_truncated, true);
});

test('installed Responses SDK pre-observer HTTP200 error is redacted, remains failed and is not retried', async () => {
  const directory = await mkdtemp(join(tmpdir(), 't1-sdk-error-diagnostic-'));
  const secret = 'synthetic-known-sdk-error-key?value=7';
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume only synthetic local input. */ }
    requests++;
    const error = { message: 'synthetic_fixture_failure api_key=' + secret +
      '; https://fixture.invalid/v1?token=hidden-query\nAuthorization: Bearer hidden-header', type: 'fixture_error', code: 'fixture_error' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('event: error\ndata: ' + JSON.stringify({ error }) + '\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  try {
    const config = new ModelConfig('fixture', endpoint, 'gpt-6-luna', secret);
    const budget = new ExtractionBudget(join(directory, 'ledger.json'), endpoint);
    const created = await createExtractionSession(config, developmentProfile(config.modelId), [], directory, budget, 'synthetic-pre-observer-error');
    const result = await promptExtractionSession(created, 'Synthetic diagnostic only; no medical source.', budget);
    assert.equal(result.error?.code, 'model_response_failed');
    assert.equal(requests, 1);
    assert.equal(created.entries[0]?.status, 200);
    assert.equal(created.entries[0]?.stream_event_count, undefined);
    assert.equal(created.entries[0]?.response_model_identity_status, 'unknown');
    assert.equal(created.entries[0]?.usage_status, 'missing_usage_conservative_reservation');
    const event = result.events.find(event => event.type === 'assistant_response');
    assert.ok(event); assert.match(String(event.sdk_error_message), /synthetic_fixture_failure/);
    assert.match(String(event.sdk_error_sha256), /^[a-f0-9]{64}$/u);
    const persisted = JSON.stringify(result) + await readFile(join(directory, 'ledger.json'), 'utf8');
    for (const value of [secret, 'hidden-header', 'hidden-query', 'fixture.invalid/v1']) assert.ok(!persisted.includes(value));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
