import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { ExtractionStore, RunStore } from "@t1/agent";
import { ContractError } from "@t1/contracts";
import { WorkbenchWorkflow } from "../src/workflow.js";
import { buildApp } from "../src/app.js";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const gatewayPath = fileURLToPath(new URL("../../pi-web/app/api/t1/[...path]/route.ts", import.meta.url));
const { DELETE } = await import(gatewayPath) as { DELETE(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> };

test("the actual Next DELETE handler forwards only the selected run to an isolated workflow", async context => {
  const directory = await mkdtemp(resolve("runtime-data/gateway-run-delete-")), extraction = new ExtractionStore(resolve(directory, "fixture.sqlite")), legacy = new RunStore(":memory:");
  const workflow = new WorkbenchWorkflow(extraction, { directory, sources: false,
    runner: { controlled: true, provider: "gateway-fixture", model_id: "no-model", execute: async () => { throw new Error("unexpected_model_call"); } },
    parse: async () => { throw new ContractError("fixture_parse_end"); } });
  const app = buildApp(legacy, undefined, workflow), calls: string[] = [];
  context.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:3210\/api\/workbench\/(?:runs|batches)\//); calls.push(url);
    const response = await app.inject({ method: "DELETE", url: new URL(url).pathname, payload: Buffer.from(init.body as Uint8Array), headers: { "content-type": "application/json" } });
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  });
  const remove = (id: string) => DELETE(new Request("http://127.0.0.1:30154/api/t1/workbench/runs/" + id, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ path: ["workbench", "runs", id] }) });
  try {
    const paper = (await workflow.upload(Buffer.from("%PDF-1.4\n% GATEWAY FIXTURE\n%%EOF\n"), "gateway.pdf")).paper;
    const first = (await workflow.start(paper.id, workflow.scopeCatalog().default_scope)).run.run_id, second = (await workflow.start(paper.id, workflow.scopeCatalog().default_scope)).run.run_id;
    await workflow.waitForIdle();
    const response = await remove(first); assert.equal(response.status, 200); assert.equal((await response.json()).run_id, first);
    assert.deepEqual((await workflow.runs()).map(run => run.run_id), [second]); assert.equal((await workflow.papers()).length, 1);
    assert.equal((await remove(first)).status, 200); assert.equal((await remove("missing-run")).status, 404); assert.equal(calls.length, 3);
    const batchId = randomUUID(), member = (await workflow.start(paper.id, workflow.scopeCatalog().default_scope, undefined, { kind: 'batch', batch_id: batchId })).run;
    await workflow.waitForIdle();
    assert.equal((await remove(member.run_id)).status, 409);
    const batch = await DELETE(new Request("http://127.0.0.1:30154/api/t1/workbench/batches/" + batchId, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ path: ["workbench", "batches", batchId] }) });
    assert.equal(batch.status, 200); assert.deepEqual((await batch.json()).run_ids, [member.run_id]); assert.deepEqual((await workflow.runs()).map(run => run.run_id), [second]);
  } finally { await app.close(); legacy.close(); extraction.close(); await rm(directory, { recursive: true, force: true }); }
});
