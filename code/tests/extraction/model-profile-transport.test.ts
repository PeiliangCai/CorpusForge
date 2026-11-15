import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ModelConfig, ExtractionBudget, createExtractionSession, developmentProfile, promptExtractionSession } from '@t1/agent';

function chatStream(model: string) {
  const base = { id: 'synthetic-chat-1', object: 'chat.completion.chunk', created: 1, model };
  return new Response([
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic transport only.' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

test('Chat Completions records literal model labels and halts an unlisted alias; none omits reasoning fields', async context => {
  const directory = await mkdtemp(resolve('runtime-data/profile-chat-test-'));
  const config = new ModelConfig('synthetic-chat', 'https://synthetic.invalid/v1', 'synthetic-model', 'synthetic-placeholder-only');
  const requests: Record<string, unknown>[] = []; let returnedModel = config.modelId;
  context.mock.method(globalThis, 'fetch', async (request: Request) => {
    assert.equal(request.url, 'https://synthetic.invalid/v1/chat/completions'); requests.push(await request.clone().json()); return chatStream(returnedModel);
  });
  try {
    for (const mismatch of [false, true]) {
      returnedModel = mismatch ? 'prefix-' + config.modelId : config.modelId;
      const budget = new ExtractionBudget(resolve(directory, `${mismatch}-ledger.json`), config.baseUrl);
      const profile = { ...developmentProfile(config.modelId, 'openai-completions'), reasoning_effort: 'none' as const, context_window: 32768, max_output_tokens: 4096,
        model_capacity_source: 'user_configured_local_limits_not_verified_supplier_capacity' as const };
      const created = await createExtractionSession(config, profile, [], resolve(directory, String(mismatch)), budget, 'synthetic-chat-no-network');
      const result = await promptExtractionSession(created, 'Synthetic transport test only.', budget);
      assert.equal(result.error?.code, mismatch ? 'response_model_identity_mismatch' : undefined);
      assert.equal(budget.ledger.requests[0]!.provider_response_model, returnedModel);
      assert.equal(budget.ledger.requests[0]!.response_model_identity_status, mismatch ? 'mismatch' : 'matched');
      assert.ok(budget.ledger.requests[0]!.response_model_observations!.every(observation => observation.source === 'provider_stream_event.chat_completion.model'));
      assert.equal(requests.at(-1)!.reasoning, undefined); assert.equal(requests.at(-1)!.reasoning_effort, undefined);
      assert.equal(created.audit.application_context_estimate_limit, 32768 - 4096);
      if (mismatch) assert.throws(() => budget.begin(config.modelId, 'must-not-send', 0, '{}', 4096), /response_model_identity_mismatch/);
    }
    assert.equal(requests.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a configured context bound blocks the SDK before fetch and does not claim verified supplier capacity', async context => {
  const directory = await mkdtemp(resolve('runtime-data/profile-context-test-'));
  let requests = 0; context.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('context guard must stop before transport'); });
  try {
    const config = new ModelConfig('synthetic-context', 'https://synthetic.invalid/v1', 'synthetic-model', 'synthetic-placeholder-only');
    const budget = new ExtractionBudget(resolve(directory, 'ledger.json'), config.baseUrl);
    const created = await createExtractionSession(config, { ...developmentProfile(config.modelId), reasoning_effort: 'none', context_window: 4096,
      max_output_tokens: 4095, model_capacity_source: 'user_configured_local_limits_not_verified_supplier_capacity' }, [], directory, budget, 'synthetic-context-no-network');
    const result = await promptExtractionSession(created, 'A prompt larger than the one-token local context budget.', budget);
    assert.equal(result.error?.code, 'application_context_estimate_limit'); assert.equal(requests, 0); assert.equal(budget.ledger.requests.length, 0);
    assert.equal(created.audit.model_capacity_source, 'user_configured_local_limits_not_verified_supplier_capacity');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Luna medium reaches the installed Responses SDK with fixed reasoning/output and no unverified sampling parameters', async context => {
  const directory = await mkdtemp(resolve('runtime-data/profile-luna-transport-'));
  const config = new ModelConfig('agicto', 'https://api.agicto.cn/v1', 'gpt-6-luna', 'synthetic-placeholder-only');
  const requests: Record<string, unknown>[] = [];
  context.mock.method(globalThis, 'fetch', async (request: Request) => {
    assert.equal(request.url, 'https://api.agicto.cn/v1/responses'); requests.push(await request.clone().json());
    return Response.json({ error: { message: 'Synthetic transport rejection. No provider request sent.' } }, { status: 400 });
  });
  // Advance the actual Date constructor and Date.now across different days.
  // The SDK system-prompt renderer also gets inspected in the acceptance record.
  context.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 1) });
  try {
    for (const name of ['first', 'second']) {
      if (name === 'second') context.mock.timers.setTime(Date.UTC(2040, 5, 1));
      const budget = new ExtractionBudget(resolve(directory, name + '-ledger.json'), config.baseUrl);
      const created = await createExtractionSession(config, developmentProfile(config.modelId), [], resolve(directory, name), budget, 'synthetic-luna-repeated-input');
      await promptExtractionSession(created, 'Identical synthetic source input for transport inspection only.', budget);
    }
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.model, 'gpt-6-luna'); assert.deepEqual(request.reasoning, { effort: 'medium', summary: 'auto' });
      assert.equal(request.max_output_tokens, 8192); assert.equal(request.store, false);
      assert.equal(request.temperature, undefined); assert.equal(request.top_p, undefined); assert.equal(request.seed, undefined);
      assert.equal(request.previous_response_id, undefined); assert.equal(request.prompt_cache_key, undefined);
    }
    assert.deepEqual(requests[0], requests[1], 'fresh sessions with identical model-visible input produce identical request bodies');
    assert.match(JSON.stringify(requests[0]!.input), /pi-evidence-context/);
    assert.doesNotMatch(JSON.stringify(requests[0]!.input), /2026-11-01|2040-06-01/);
    console.log(JSON.stringify({ sdk: 'installed_pi_responses', model: 'gpt-6-luna', reasoning: 'medium', max_output_tokens: 8192,
      temperature: 'omitted', top_p: 'omitted', seed: 'omitted', store: false, fresh_session_bodies_identical: true,
      simulated_dates: ['2026-11-01', '2040-06-01'], clock_fields_in_model_input: false, neutral_cwd: true, external_requests: 0, paid_calls: 0 }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
