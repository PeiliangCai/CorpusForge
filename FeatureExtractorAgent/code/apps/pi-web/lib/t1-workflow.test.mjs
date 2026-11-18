import assert from "node:assert/strict";
import test from "node:test";
import { applicableChoices, refreshDraftScope, scopeProblems } from "../t1/scope.ts";
import { isT1ApiMethod, isT1ApiPath, t1BackendPath } from "../t1/gateway-policy.ts";

// Synthetic nonmedical identifiers; this catalog is never offered by the production service.
const catalog = { catalog_version: "engineering-only", status: "development_only", fixture: true,
  cancers: [{ id: "a" }, { id: "b" }], image_types: [{ id: "x", cancer_ids: ["a"] }, { id: "y", cancer_ids: ["b"] }],
  features: [], bindings: [{ binding_id: "ax", cancer_ids: ["a"], image_type_ids: ["x"] }, { binding_id: "by", cancer_ids: ["b"], image_type_ids: ["y"] }] };
const scope = { scope_version: "1", catalog_version: catalog.catalog_version, matching_policy_version: "engineering-only",
  cancers: { mode: "all", ids: [] }, image_types: { mode: "all", ids: [] }, features: { mode: "all", binding_ids: [] } };
const data = { catalog, restricted_available: true, development_only: true, default_scope: scope };
test("two unrestricted dimensions do not require medical approval", () => {
  assert.deepEqual(scopeProblems(scope, { ...data, restricted_available: false }), []);
});
test("empty, removed and incompatible choices stay selected and block a new task", () => {
  const changed = { ...scope, cancers: { mode: "selected", ids: ["a", "removed"] }, image_types: { mode: "selected", ids: ["x", "y"] } };
  const before = structuredClone(changed);
  assert.deepEqual(applicableChoices(changed, catalog).images.map(x => x.id), ["x"]);
  assert.deepEqual(scopeProblems(changed, data), ["cancers_invalid", "image_types_invalid"]);
  assert.deepEqual(changed, before);
  assert.ok(scopeProblems({ ...scope, cancers: { mode: "selected", ids: [] } }, data).includes("cancers_selected_empty"));
  assert.ok(scopeProblems({ ...scope, features: { mode: "selected", binding_ids: ["ax"] } }, data).includes("feature_scope_removed"));
});
test("refresh takes the new version and preserves IDs; multiselect remains exact", () => {
  const selected = { ...scope, cancers: { mode: "selected", ids: ["a", "b"] }, image_types: { mode: "selected", ids: ["x", "y"] } };
  assert.deepEqual(scopeProblems(selected, data), []);
  const updated = { ...data, catalog: { ...catalog, catalog_version: "updated" } };
  const refreshed = refreshDraftScope(selected, updated);
  assert.equal(refreshed.catalog_version, "updated");
  assert.deepEqual(refreshed.cancers, selected.cancers);
  assert.deepEqual(refreshed.image_types, selected.image_types);
  assert.deepEqual(scopeProblems(refreshed, updated), []);
  assert.ok(scopeProblems(selected, updated).includes("catalog_version_mismatch"));
});
test("T1 mutation gateway admits only business methods on their exact routes", () => {
  assert.equal(isT1ApiMethod("/api/t1/workbench/models", "GET"), true);
  assert.equal(isT1ApiMethod("/api/t1/workbench/models", "POST"), true);
  assert.equal(isT1ApiMethod("/api/t1/workbench/models", "PUT"), false);
  assert.equal(isT1ApiMethod("/api/t1/workbench/models", "DELETE"), false);
  for (const path of ["/api/models", "/api/models-config", "/api/auth/api-key/agicto", "/api/t1/workbench/models/discover"])
    assert.equal(isT1ApiPath(path), false);
  assert.equal(isT1ApiMethod("/api/t1/workbench/papers", "POST"), true);
  assert.equal(isT1ApiMethod("/api/t1/workbench/papers/p-1/pdf", "PUT"), true);
  assert.equal(isT1ApiMethod("/api/t1/workbench/runs/r-1/records/c-1/review", "POST"), true);
  assert.equal(isT1ApiMethod("/api/t1/workbench/runs/r-1/records/c-1", "PATCH"), true);
  assert.equal(isT1ApiMethod("/api/t1/workbench/runs/r-1/exports/approved_package", "POST"), false);
  assert.equal(isT1ApiMethod("/api/t1/workbench/capabilities", "DELETE"), false);
  assert.equal(isT1ApiMethod("/api/t1/workbench/runs/r-1/cancel", "GET"), false);
  assert.equal(isT1ApiPath("/api/t1/workbench/papers/p-1/../../files"), false);
  assert.equal(isT1ApiPath("/api/agent/new"), false);
  assert.equal(t1BackendPath(["workbench", "runs", "run:1", "figures", "asset:1"]), "/api/workbench/runs/run%3A1/figures/asset%3A1");
});

test("historical ID encoding passes only the allowed colon/comma alphabet without path decoding", () => {
  assert.equal(isT1ApiMethod("/api/t1/workbench/runs/b0%3Arevalidation%2C1/events", "GET"), true);
  assert.equal(isT1ApiMethod("/api/t1/workbench/runs/b0%3arevalidation/records/ev%2c1/review", "POST"), true);
  assert.equal(isT1ApiMethod("/api/t1/workbench/runs/b0%3Arevalidation/cancel", "GET"), false);
  for (const value of ["run%2F1", "run%5C1", "run%253A1", "run%252F1", "%2e%2e", "%252e%252e", "run%00", "run%3Fquery"]) {
    assert.equal(isT1ApiPath(`/api/t1/workbench/runs/${value}`), false, value);
  }
});
