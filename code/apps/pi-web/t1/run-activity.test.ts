import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchRun } from "../../../packages/contracts/src/workbench";
import { ACTIVITY_FRESH_MS, runActivity } from "./run-activity";

const at = Date.parse("2026-11-15T11:00:00Z");
const run = (state = "extracting"): WorkbenchRun => ({ run_id: "r", document_id: "p", state, fixture: true, result_ready: false, candidate_count: 0,
  progress: { schema_version: "t1-workbench-progress-1", stage: "extracting", telemetry: "events", completed: 0, total: 547, candidate_records: 0, completed_batches: 1, total_batches: 24, failed_batches: 1, current_batch_index: 3,
    operation: { kind: "model_request", state: "waiting_response", started_at: new Date(at - 5000).toISOString(), elapsed_ms: 5000, attempt: 1, max_retries: 2 } } });

test("a fresh observed host request exposes elapsed wait without changing completion or batch identity", () => {
  const value = run(), activity = runActivity(value, value.state, "connected", at, at + 2000);
  assert.equal(activity.status, "waiting"); assert.equal(activity.elapsedMs, 7000); assert.equal(activity.currentBatchIndex, 3); assert.equal(activity.failedBatches, 1);
  assert.equal(value.progress?.completed, 0); assert.equal(value.progress?.completed_batches, 1);
});

test("response, tool and scheduled-retry states come only from matching host operation receipts", () => {
  for (const [operation, expected] of [
    [{ kind: "model_request", state: "receiving_response" }, "receiving"], [{ kind: "tool", state: "executing", tool_name: "read_document_blocks" }, "tool"], [{ kind: "retry", state: "scheduled" }, "retry"],
  ] as const) {
    const value = run(); value.progress!.operation = { ...value.progress!.operation!, ...operation };
    assert.equal(runActivity(value, value.state, "connected", at, at).status, expected);
  }
});

test("disconnected or stale observations display snapshots and freeze elapsed operation time", () => {
  assert.equal(runActivity(run(), "extracting", "reconnecting", at, at + 60_000).status, "disconnected");
  const stale = runActivity(run(), "extracting", "connected", at, at + ACTIVITY_FRESH_MS + 1);
  assert.equal(stale.status, "stale"); assert.equal(stale.elapsedMs, 5000);
  assert.equal(runActivity(run(), "extracting", "connected", undefined, at).status, "stale");
});

test("terminal states outrank stale or leftover waiting receipts, including cancellation still saving results", () => {
  for (const state of ["cancelled", "failed", "interrupted"]) {
    const activity = runActivity(run(state), state, "connected", at, at + 1000);
    assert.equal(activity.status, "stopped"); assert.equal(activity.operation, undefined); assert.equal(activity.elapsedMs, undefined); assert.equal(activity.currentBatchIndex, undefined);
  }
  const completed = run("completed"); completed.result_ready = true; completed.task_processing_complete = true;
  assert.equal(runActivity(completed, completed.state, "reconnecting", at, at + 90_000).status, "ended");
  assert.equal(runActivity(run("partial"), "partial", "connected", at, at).status, "finalizing");
});

test("legacy runs, invalid operation records and unknown batch indexes never invent in-flight work", () => {
  const value = run(); delete value.progress!.operation; delete value.progress!.current_batch_index;
  assert.equal(runActivity(value, value.state, "connected", at, at).status, "processing");
  assert.equal(runActivity(value, value.state, "connected", at, at).currentBatchIndex, undefined);
  value.progress!.operation = { kind: "model_request", state: "waiting_response", elapsed_ms: 20, started_at: "unrecorded" };
  assert.equal(runActivity(value, value.state, "connected", at, at).status, "processing");
  value.progress!.current_batch_index = 25; assert.equal(runActivity(value, value.state, "connected", at, at).currentBatchIndex, undefined);
  value.progress!.current_batch_index = 3; assert.equal(runActivity(value, "reconciling", "connected", at, at).currentBatchIndex, undefined);
});

test("only explicit final host termination codes explain quota or time stops; individual request failures do not", () => {
  for (const reason of ["experiment_input_token_limit", "experiment_output_token_limit", "experiment_request_limit", "experiment_time_limit", "document_time_limit", "request_time_limit", "pi_session_time_limit"]) {
    const value = run("partial"); value.result_ready = true; Object.assign(value.progress!, { termination_reason: reason });
    const activity = runActivity(value, value.state, "connected", at, at);
    assert.equal(activity.status, "stopped"); assert.equal(activity.terminationReason, reason); assert.equal(activity.stopKind, reason.includes("token_limit") || reason === "experiment_request_limit" ? "quota" : "time");
    value.result_ready = false; assert.equal(runActivity(value, value.state, "connected", at, at).terminationReason, undefined);
  }
  const value = run("partial"); value.result_ready = true; value.progress!.last_request = { outcome: "failed", finished_at: new Date(at).toISOString(), error_code: "provider_timeout" };
  assert.equal(runActivity(value, value.state, "connected", at, at).stopKind, undefined);
  Object.assign(value.progress!, { termination_reason: "unknown" }); assert.equal(runActivity(value, value.state, "connected", at, at).status, "ended");
});
