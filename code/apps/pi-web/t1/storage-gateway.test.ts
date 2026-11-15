import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "../app/api/t1/[...path]/route";
import { isT1ApiMethod, isT1ApiPath, t1BackendPath } from "./gateway-policy";
import { cleanupStorage, previewStorage, WorkbenchError } from "./api";

test("storage gateway admits only summary reads and the two explicit JSON operations", () => {
  for (const [suffix, allowed] of [["", ["GET", "HEAD"]], ["/preview", ["POST"]], ["/cleanup", ["POST"]]] as const) {
    const path = `/api/t1/workbench/storage${suffix}`;
    assert.equal(isT1ApiPath(path), true);
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) assert.equal(isT1ApiMethod(path, method), (allowed as readonly string[]).includes(method), `${method} ${path}`);
    assert.equal(t1BackendPath(["workbench", "storage", ...suffix.split("/").filter(Boolean)]), `/api/workbench/storage${suffix}`);
  }
  for (const path of ["/api/t1/workbench/storage/delete", "/api/t1/workbench/storage/cleanup/all", "/api/t1/workbench/storage/%2e%2e", "/api/t1/workbench/storage/files", "/api/storage"]) assert.equal(isT1ApiPath(path), false);
});

test("gateway forwards exactly the preview and explicit selection; wrong methods and query selectors never reach upstream", async context => {
  const forwarded: Array<{ url: string; method?: string; body: string }> = [];
  context.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    forwarded.push({ url, method: init.method, body: init.body ? new TextDecoder().decode(init.body as Uint8Array) : "" });
    return Response.json({ accepted: true });
  });
  const selection = { preview_id: "preview-fixture", version: "version-fixture", candidate_ids: ["only-this-candidate"] };
  const request = (suffix: string, method: string, body?: unknown, query = "") => new Request(`http://127.0.0.1:30152/api/t1/workbench/storage${suffix}${query}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const route = (suffix: string) => ({ params: Promise.resolve({ path: ["workbench", "storage", ...suffix.split("/").filter(Boolean)] }) });
  assert.equal((await POST(request("/preview", "POST", {}), route("/preview"))).status, 200);
  assert.equal((await POST(request("/cleanup", "POST", selection), route("/cleanup"))).status, 200);
  assert.deepEqual(forwarded, [
    { url: "http://127.0.0.1:3210/api/workbench/storage/preview", method: "POST", body: "{}" },
    { url: "http://127.0.0.1:3210/api/workbench/storage/cleanup", method: "POST", body: JSON.stringify(selection) },
  ]);
  assert.equal((await GET(request("/cleanup", "GET"), route("/cleanup"))).status, 405);
  assert.equal((await POST(request("", "POST", {}), route(""))).status, 405);
  assert.equal((await POST(request("/cleanup", "POST", selection, "?path=/tmp"), route("/cleanup"))).status, 400);
  assert.equal(forwarded.length, 2);
});

test("storage client preserves the preview selection and propagates a stale-preview refusal", async context => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  context.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    return path.endsWith("/preview") ? Response.json({ preview_id: "preview-fixture", version: "version-fixture", candidates: [] }) : Response.json({ error: "storage_preview_stale" }, { status: 409 });
  });
  const controller = new AbortController();
  await previewStorage(controller.signal);
  const selection = { preview_id: "preview-fixture", version: "version-fixture", candidate_ids: ["candidate-b"] };
  await assert.rejects(cleanupStorage(selection), cause => cause instanceof WorkbenchError && cause.status === 409 && cause.code === "storage_preview_stale");
  assert.equal(calls[0]?.path, "/api/t1/workbench/storage/preview");
  assert.equal(calls[0]?.init.signal, controller.signal);
  assert.equal(calls[0]?.init.body, "{}");
  assert.equal(calls[1]?.init.body, JSON.stringify(selection));
  assert.ok(calls.every(call => call.init.method === "POST" && call.init.cache === "no-store"));
});
