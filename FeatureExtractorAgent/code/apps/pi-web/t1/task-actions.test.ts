import assert from "node:assert/strict";
import test from "node:test";
import { canCancelRun, cancellationResult, runDeletionBlocked } from "./task-actions";

test("only active extraction states offer cancellation", () => {
  for (const state of ["queued", "parsing", "extracting", "reconciling"]) assert.equal(canCancelRun({ state }), true);
  for (const state of ["completed", "partial", "failed", "cancelled", "interrupted", "unknown"]) assert.equal(canCancelRun({ state }), false);
});

test("deletion requires the target to have ended and finished saving", () => {
  for (const state of ["queued", "parsing", "extracting", "reconciling", "unknown"]) assert.equal(runDeletionBlocked({ state, result_ready: true }), true);
  for (const state of ["completed", "partial", "failed", "cancelled", "interrupted"]) {
    assert.equal(runDeletionBlocked({ state, result_ready: false }), true);
    assert.equal(runDeletionBlocked({ state, result_ready: true }), false);
    assert.equal(runDeletionBlocked({ state }), false);
  }
});

test("a cancellation response reports the actual state, including terminal races and finalization", () => {
  assert.equal(cancellationResult("cancelled"), "cancelDone");
  for (const state of ["completed", "partial", "failed", "interrupted"]) assert.equal(cancellationResult(state), "cancelEnded");
  assert.equal(cancellationResult("reconciling"), "cancelFinalizing");
  for (const state of ["queued", "parsing", "extracting", "unknown"]) assert.equal(cancellationResult(state), "cancelUnconfirmed");
});
