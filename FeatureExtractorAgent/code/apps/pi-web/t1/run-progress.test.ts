import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchRun } from "../../../packages/contracts/src/workbench";
import { contentUnitComposition, progressDuration, retainProgressEvent, runProgress, type ProgressEvent } from "./run-progress";

const event = (type: string, detail: Record<string, unknown>): ProgressEvent => ({ type, detail, timestamp: "2026-11-14T08:00:00Z" });
const run = (state: string, progress?: WorkbenchRun["progress"]) => ({ state, candidate_count: 13, progress } as WorkbenchRun);

test("classified content groups use their own completion receipts and do not borrow legacy paragraph or line counts", () => {
  let events: readonly ProgressEvent[] = [];
  for (const value of [event("coverage_inventory", { progress_unit: "content_units", total_content_units: 3, total_paragraphs: 2158, dispatched_blocks: 4484 }),
    event("batch", { batch_id: "one", status: "completed", assigned_block_ids: ["raw-a", "raw-b"], completed_content_unit_ids: ["body-1"], completed_paragraph_ids: ["wrong-1", "wrong-2"] }),
    event("batch", { batch_id: "two", status: "completed", assigned_block_ids: ["raw-c"], completed_content_unit_ids: ["body-1", "figure-1"] }),
    event("summary_read", { completed_content_unit_ids: ["fake"] })]) events = retainProgressEvent(events, value);
  const result = runProgress(run("extracting"), "extracting", {}, events);
  assert.equal(result.unit, "content_units"); assert.equal(result.completed, 2); assert.equal(result.total, 3); assert.equal(result.percent, 66);
  const saved = runProgress(run("partial"), "partial", { progress_unit: "content_units", dispatched_content_units: 3, explicitly_completed_content_units: 1, dispatched_paragraphs: 2158 }, []);
  assert.equal(saved.completed, 1); assert.equal(saved.total, 3); assert.equal(saved.success, false);
});

test("content composition displays recorded categories only and cannot infer natural paragraphs from old totals", () => {
  assert.deepEqual(contentUnitComposition({ unit: "paragraphs", total: 2158 }), []);
  assert.deepEqual(contentUnitComposition({ unit: "content_units", unit_counts: { paragraph: 10, figure_text: 40, heading: 2, source_fragment: 3, caption: -1, footnote: 0, text_item: 1.5 }, completed_unit_counts: { paragraph: 5, figure_text: 41 } }), [
    { kind: "paragraph", total: 10, completed: 5 }, { kind: "heading", total: 2, completed: undefined }, { kind: "figure_text", total: 40, completed: undefined }, { kind: "source_fragment", total: 3, completed: undefined },
  ]);
});

test("new content units use cumulative completed parents, never raw lines, sentence parts or supplemental reads", () => {
  const events = [event("coverage_inventory", { progress_unit: "paragraphs", total_paragraphs: 2, dispatched_blocks: 9 }),
    event("batch", { batch_id: "one", status: "completed", assigned_block_ids: ["a", "b"], completed_paragraph_ids: [] }),
    event("summary_read", { source_block_ids: ["c", "d"], completed_paragraph_ids: ["fake"] })];
  assert.equal(runProgress(run("extracting"), "extracting", undefined, events).completed, 0);
  events.push(event("batch", { batch_id: "two", status: "completed", assigned_block_ids: ["c"], completed_paragraph_ids: ["parent-one"] }));
  const p = runProgress(run("extracting"), "extracting", undefined, events);
  assert.equal(p.unit, "paragraphs"); assert.equal(p.completed, 1); assert.equal(p.total, 2); assert.equal(p.percent, 50);
  const saved = runProgress(run("partial"), "partial", { progress_unit: "paragraphs", dispatched_paragraphs: 2, explicitly_completed_paragraphs: 1, source_glyph_issue_block_ids: ["a"] }, []);
  assert.equal(saved.unit, "paragraphs"); assert.equal(saved.completed, 1); assert.equal(saved.gap, undefined); assert.equal(saved.success, false);
  assert.equal(runProgress(run("extracting"), "extracting", undefined, [event("coverage_inventory", { dispatched_blocks: 9 })]).unit, "source_blocks");
});

test("existing active runs count unique explicitly completed dispatched blocks, never summary rereads or retries", () => {
  const events = [event("state", { state: "extracting" }), event("coverage_inventory", { dispatched_blocks: 4, task_scope_blocks: 5 }),
    event("batch", { status: "failed", assigned_block_ids: ["a", "b"] }), event("batch", { status: "completed", assigned_block_ids: ["a", "b"] }),
    event("batch", { status: "completed", explicit_completion_received: false, assigned_block_ids: ["c", "d"] }),
    event("batch", { status: "completed", assigned_block_ids: ["a", "b"] }), event("summary_read", { source_block_ids: ["a", "b", "c", "d", "gap"] })];
  const current = runProgress(run("extracting"), "extracting", undefined, events);
  assert.equal(current.completed, 2); assert.equal(current.total, 4); assert.equal(current.percent, 50);
  assert.equal(current.success, false);
  assert.equal(runProgress(run("reconciling"), "reconciling", undefined, events).percent, undefined);
  const stale = run("extracting", { schema_version: "t1-workbench-progress-1", stage: "extracting", completed: 0, total: 4, candidate_records: 13, telemetry: "events" });
  assert.equal(runProgress(stale, "extracting", undefined, events).percent, 50);
});

test("reconciliation and source gaps remain explicit after all dispatched blocks finish", () => {
  const progress: WorkbenchRun["progress"] = { schema_version: "t1-workbench-progress-1", stage: "reconciling", completed: 2929, total: 2929,
    unit: "source_blocks", candidate_records: 13, source_gap_blocks: 41, telemetry: "events" };
  const current = runProgress(run("reconciling", progress), "reconciling", { task_processing_complete: false }, []);
  assert.equal(current.completed, 2929); assert.equal(current.total, 2929); assert.equal(current.gap, undefined);
  assert.equal(current.percent, undefined); assert.equal(current.success, false); assert.equal(current.stageIndex, 3);
  for (const state of ["partial", "failed", "cancelled", "interrupted"]) {
    const ended = runProgress(run(state, { ...progress, stage: state as "partial" }), state, { task_processing_complete: false }, []);
    assert.equal(ended.ended, true); assert.equal(ended.percent, undefined); assert.equal(ended.success, false);
  }
});

test("task completion and source limitations agree across status and progress after final saving", () => {
  for (const state of ["completed", "partial"]) {
    const current = { ...run(state), result_ready: true };
    const coverage = { task_processing_complete: true, whole_document_summary_complete: true, parser_status: "partial", image_text_unverified_pages: [1] };
    const progress = runProgress(current, state, coverage, [event("state", { state: "reconciling" })]);
    assert.equal(progress.success, true); assert.equal(progress.ended, true); assert.equal(progress.stageIndex, 4);
    assert.equal(progress.stage, state, "preserve the engine state and source limitations");
    for (const saved of [{ task_processing_complete: false, whole_document_summary_complete: true }, { whole_document_summary_complete: true },
      { task_processing_complete: false, whole_document_summary_complete: false }]) {
      assert.equal(runProgress(current, state, saved, []).success, false);
    }
    const finalizing = runProgress({ ...current, result_ready: false }, state, coverage, []);
    assert.equal(finalizing.success, false); assert.equal(finalizing.finalizing, true); assert.equal(finalizing.ended, false);
    assert.equal(finalizing.stage, "reconciling"); assert.equal(finalizing.stageIndex, 3); assert.equal(finalizing.percent, undefined);
  }
});

test("unknown or invalid totals and legacy terminal runs never acquire invented progress or elapsed time", () => {
  const unknown = runProgress(run("extracting"), "extracting", undefined, [event("batch", { status: "completed", assigned_block_ids: ["a"] })]);
  assert.equal(unknown.total, undefined); assert.equal(unknown.percent, undefined);
  const legacy = runProgress({ ...run("completed"), created_at: "2020-01-01T00:00:00Z" }, "completed", {}, []);
  assert.equal(legacy.success, false); assert.equal(legacy.executionElapsedMs, undefined); assert.equal(legacy.percent, undefined);
  assert.equal(runProgress(run("completed"), "completed", { task_processing_complete: true }, []).success, true);
  for (const [completed, total] of [[101, 100], [0, 0]]) {
    const invalid = runProgress(run("extracting", { schema_version: "t1-workbench-progress-1", stage: "extracting", candidate_records: 0, telemetry: "events", completed, total }), "extracting", {}, []);
    assert.equal(invalid.percent, undefined);
  }
});

test("replayed state events cannot regress current detail or declare finalization complete", () => {
  assert.equal(runProgress(run("extracting"), "extracting", undefined, [event("state", { state: "queued" })]).stage, "extracting");
  assert.equal(runProgress(run("extracting"), "extracting", undefined, [event("state", { state: "reconciling" })]).stage, "reconciling");
  assert.equal(runProgress(run("reconciling"), "reconciling", undefined, [event("state", { state: "completed" })]).stage, "reconciling");
  assert.equal(runProgress(run("cancelled"), "cancelled", undefined, [event("state", { state: "extracting" })]).stage, "cancelled");
  assert.equal(progressDuration(3_661_000), "1:01:01"); assert.equal(progressDuration(61_000), "1:01");
});

test("long current-task event streams preserve small work receipts while dropping diagnostic payloads", () => {
  let snapshot: readonly ProgressEvent[] = [];
  for (const value of [event("state", { state: "extracting" }), event("coverage_inventory", { dispatched_blocks: 8, source_text: "not retained" }),
    event("batch", { batch_id: "window-1", status: "failed", assigned_block_ids: ["a", "b"], model_response: "not retained" }),
    event("batch", { batch_id: "window-1", status: "completed", assigned_block_ids: ["a", "b"], model_response: "not retained" }),
    event("batch", { batch_id: "window-2", status: "completed", explicit_completion_received: false, assigned_block_ids: ["c", "d"] }),
    ...Array.from({ length: 700 }, () => event("tool", { payload: "not retained" }))]) snapshot = retainProgressEvent(snapshot, value);
  assert.equal(snapshot.length, 4); assert.ok(!JSON.stringify(snapshot).includes("not retained"));
  const progress = runProgress(run("extracting"), "extracting", undefined, snapshot);
  assert.equal(progress.completed, 2); assert.equal(progress.total, 8); assert.equal(progress.percent, 25);
  snapshot = retainProgressEvent(snapshot, event("state", { state: "reconciling" }));
  snapshot = retainProgressEvent(snapshot, event("state", { state: "partial" }));
  assert.equal(runProgress(run("partial"), "partial", {}, snapshot).stageIndex, 3);
});
