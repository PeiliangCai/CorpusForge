import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchRun } from "../../../packages/contracts/src/workbench";
import { canCancelRun, cancellablePaperRuns, cancellationResult } from "./task-actions";

test("paper actions include every active task even when a completed result is displayed", () => {
  const runs = [
    { run_id: "old", document_id: "a", state: "completed", candidate_count: 8, created_at: "2026-11-01T00:00:00Z" },
    { run_id: "parse", document_id: "a", state: "parsing", candidate_count: 0, created_at: "2026-11-02T00:00:00Z" },
    { run_id: "queue", document_id: "a", state: "queued", candidate_count: 0, created_at: "2026-11-03T00:00:00Z" },
    { run_id: "extract", document_id: "a", state: "extracting", candidate_count: 1 },
    { run_id: "finish", document_id: "a", state: "reconciling", candidate_count: 2 },
    { run_id: "other", document_id: "b", state: "parsing", candidate_count: 0 },
    { run_id: "cancelled", document_id: "a", state: "cancelled", candidate_count: 2 },
  ] as WorkbenchRun[];
  assert.deepEqual(cancellablePaperRuns("a", runs).map(run => run.run_id), ["queue", "parse", "extract", "finish"]);
  assert.deepEqual(cancellablePaperRuns("unknown", runs), []);
  assert.equal(runs[0].run_id, "old");
  for (const state of ["completed", "partial", "failed", "cancelled", "interrupted", "unknown"]) assert.equal(canCancelRun({ state }), false);
});

test("a cancellation response reports the actual state, including terminal races and finalization", () => {
  assert.equal(cancellationResult("cancelled"), "cancelDone");
  for (const state of ["completed", "partial", "failed", "interrupted"]) assert.equal(cancellationResult(state), "cancelEnded");
  assert.equal(cancellationResult("reconciling"), "cancelFinalizing");
  for (const state of ["queued", "parsing", "extracting", "unknown"]) assert.equal(cancellationResult(state), "cancelUnconfirmed");
});
