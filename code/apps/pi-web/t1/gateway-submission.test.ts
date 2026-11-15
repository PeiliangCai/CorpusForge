import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/t1/[...path]/route";

test("submission keys cross only the fixed upload/start gateway; malformed keys never reach the backend", async context => {
  const forwarded: Array<{ url: string; key: string | null; body: Uint8Array }> = [];
  context.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    forwarded.push({ url, key: new Headers(init.headers).get("x-t1-request-id"), body: init.body as Uint8Array });
    return Response.json({ accepted: true }, { status: 201 });
  });
  const submit = (parts: string[], body: string, type: string, key: string) => POST(new Request("http://127.0.0.1:30152/api/t1/" + parts.join("/"), {
    method: "POST", headers: { "content-type": type, "x-t1-request-id": key, "x-t1-filename": "gateway.pdf" }, body,
  }), { params: Promise.resolve({ path: parts }) });
  assert.equal((await submit(["workbench", "papers"], "%PDF-1.4\n%%EOF\n", "application/pdf", "upload-gateway-0001")).status, 201);
  assert.equal((await submit(["workbench", "papers", "paper-1", "runs"], '{"scope":{},"submission":{"kind":"single"}}', "application/json", "start-gateway-0001")).status, 201);
  assert.deepEqual(forwarded.map(item => [item.url, item.key]), [
    ["http://127.0.0.1:3210/api/workbench/papers", "upload-gateway-0001"],
    ["http://127.0.0.1:3210/api/workbench/papers/paper-1/runs", "start-gateway-0001"],
  ]);
  assert.equal(new TextDecoder().decode(forwarded[1]!.body), '{"scope":{},"submission":{"kind":"single"}}');
  assert.equal((await submit(["workbench", "papers"], "%PDF-1.4\n%%EOF\n", "application/pdf", "bad")).status, 400);
  assert.equal(forwarded.length, 2);
});
