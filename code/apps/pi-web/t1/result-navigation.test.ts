import assert from "node:assert/strict";
import test from "node:test";
import { hasWorkbenchTaskContext, initialWorkbenchSelection, workbenchSelectionParams } from "./result-navigation";
import type { WorkbenchPaper, WorkbenchRun } from "../../../packages/contracts/src/workbench";

const papers = [
  { id: "empty", output_ids: [] },
  { id: "paper-a", output_ids: ["old-a", "new-empty-a"] },
  { id: "paper-b", output_ids: ["b", "archived-b"] },
] as WorkbenchPaper[];
const runs = [
  { run_id: "new-empty-a", document_id: "paper-a", candidate_count: 0 },
  { run_id: "b", document_id: "paper-b", candidate_count: 3 },
  { run_id: "old-a", document_id: "paper-a", candidate_count: 7 },
] as WorkbenchRun[];

test("a fresh workbench opens creation without selecting an arbitrary saved paper or task", () => {
  assert.deepEqual(initialWorkbenchSelection(new URLSearchParams(), papers, runs), {
    paperId: "", runId: null, historyId: "", recordId: "", activeTab: "newTask",
  });
});

test("an exact run and record deep link takes precedence over paper defaults", () => {
  const selected = initialWorkbenchSelection(new URLSearchParams("paper=paper-b&run=new-empty-a&record=record-4&view=figures"), papers, runs);
  assert.equal(selected.paperId, "paper-a");
  assert.equal(selected.runId, "new-empty-a");
  assert.equal(selected.recordId, "record-4");
  assert.equal(selected.activeTab, "figures");
});

test("only an explicitly listed historical output creates a history context", () => {
  const selected = initialWorkbenchSelection(new URLSearchParams("paper=paper-b&history=archived-b&record=record-2"), papers, runs);
  assert.equal(selected.runId, null);
  assert.equal(selected.historyId, "archived-b");
  assert.equal(selected.paperId, "paper-b");
  assert.equal(selected.activeTab, "records");
  assert.equal(initialWorkbenchSelection(new URLSearchParams("paper=paper-b&history=unknown-history"), papers, runs).historyId, "");
});

test("a saved PDF without an explicit task does not open its latest result or original source", () => {
  assert.equal(initialWorkbenchSelection(new URLSearchParams(), [], []).activeTab, "newTask");
  const selected = initialWorkbenchSelection(new URLSearchParams("paper=empty"), papers, runs);
  assert.equal(selected.paperId, "");
  assert.equal(selected.runId, null);
  assert.equal(selected.activeTab, "newTask");
  assert.equal(initialWorkbenchSelection(new URLSearchParams("paper=paper-a&view=records"), papers, runs).runId, null);
});

test("an unavailable explicit run clears all task selection instead of falling back to that paper", () => {
  const selected = initialWorkbenchSelection(new URLSearchParams("paper=paper-a&run=deleted-run&record=old-record"), papers, runs);
  assert.equal(selected.runId, null);
  assert.equal(selected.historyId, "");
  assert.equal(selected.paperId, "");
  assert.equal(selected.recordId, "");
  assert.equal(selected.activeTab, "newTask");
});

test("a known history id resolves to the real run and its own source snapshot", () => {
  const selected = initialWorkbenchSelection(new URLSearchParams("paper=paper-b&history=old-a"), papers, runs);
  assert.equal(selected.runId, "old-a");
  assert.equal(selected.paperId, "paper-a");
  assert.equal(selected.historyId, "");
});

test("unavailable explicit links without a paper do not borrow any other paper", () => {
  for (const query of ["run=deleted-run", "history=unknown-output"]) {
    const selected = initialWorkbenchSelection(new URLSearchParams(query), papers, runs);
    assert.equal(selected.paperId, "");
    assert.equal(selected.activeTab, "newTask");
  }
});

test("global creation and history URLs discard even otherwise valid task parameters", () => {
  for (const view of ["newTask", "tasks"]) {
    assert.deepEqual(initialWorkbenchSelection(new URLSearchParams(`paper=paper-a&run=old-a&history=archived-b&record=record-4&view=${view}`), papers, runs), {
      paperId: "", runId: null, historyId: "", recordId: "", activeTab: view,
    });
  }
});

test("refresh validation recognizes only the explicit remaining run/history, never other tasks on its paper", () => {
  const selection = { paperId: "paper-a", runId: "old-a", historyId: "" };
  assert.equal(hasWorkbenchTaskContext(selection, papers, runs), true);
  assert.equal(hasWorkbenchTaskContext(selection, papers, runs.filter(run => run.run_id !== "old-a")), false);
  assert.equal(hasWorkbenchTaskContext({ paperId: "paper-b", runId: null, historyId: "archived-b" }, papers, runs), true);
  assert.equal(hasWorkbenchTaskContext({ paperId: "empty", runId: null, historyId: "archived-b" }, papers, runs), false);
  assert.equal(hasWorkbenchTaskContext({ paperId: "paper-a", runId: null, historyId: "" }, papers, runs), false);
});

test("first-load URL normalization clears stale task parameters even when the empty selection matches initial state", () => {
  for (const query of ["paper=empty&view=newTask", "paper=paper-a&run=deleted&record=old&view=records", "paper=paper-a&view=figures"]) {
    assert.equal(workbenchSelectionParams(initialWorkbenchSelection(new URLSearchParams(query), papers, runs)).toString(), "view=newTask");
  }
  assert.equal(workbenchSelectionParams(initialWorkbenchSelection(new URLSearchParams("paper=paper-b&run=old-a&record=exact&view=records"), papers, runs)).toString(), "paper=paper-a&run=old-a&record=exact&view=records");
  assert.equal(workbenchSelectionParams({ paperId: "paper-a", runId: "old-a", historyId: "", recordId: "exact", activeTab: "tasks" }).toString(), "view=tasks");
});

