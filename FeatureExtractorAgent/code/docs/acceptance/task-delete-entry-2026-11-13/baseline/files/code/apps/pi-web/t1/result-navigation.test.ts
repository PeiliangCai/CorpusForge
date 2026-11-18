import assert from "node:assert/strict";
import test from "node:test";
import { initialWorkbenchSelection, resultRunForPaper, sidebarPaperSelection } from "./result-navigation";
import type { WorkbenchPaper, WorkbenchRun } from "../../../packages/contracts/src/workbench";

const papers = [
  { id: "empty", output_ids: [] },
  { id: "paper-a", output_ids: ["old-a", "new-empty-a"] },
  { id: "paper-b", output_ids: ["b"] },
] as WorkbenchPaper[];
const runs = [
  { run_id: "new-empty-a", document_id: "paper-a", candidate_count: 0 },
  { run_id: "b", document_id: "paper-b", candidate_count: 3 },
  { run_id: "old-a", document_id: "paper-a", candidate_count: 7 },
] as WorkbenchRun[];

test("opening the workbench surfaces retained evidence instead of an empty upload screen", () => {
  assert.deepEqual(initialWorkbenchSelection(new URLSearchParams(), papers, runs), {
    paperId: "paper-a", runId: "old-a", historyId: "", recordId: "", activeTab: "records",
  });
  assert.equal(resultRunForPaper("paper-a", runs)?.run_id, "old-a");
});

test("an exact run and record deep link takes precedence over paper defaults", () => {
  const selected = initialWorkbenchSelection(new URLSearchParams("paper=paper-b&run=new-empty-a&record=record-4&view=figures"), papers, runs);
  assert.equal(selected.paperId, "paper-a");
  assert.equal(selected.runId, "new-empty-a");
  assert.equal(selected.recordId, "record-4");
  assert.equal(selected.activeTab, "figures");
});

test("historical links and an explicit new-task view remain selectable", () => {
  const selected = initialWorkbenchSelection(new URLSearchParams("paper=paper-b&history=archived-b&record=record-2"), papers, runs);
  assert.equal(selected.runId, null);
  assert.equal(selected.historyId, "archived-b");
  assert.equal(selected.paperId, "paper-b");
  assert.equal(selected.activeTab, "records");
  assert.equal(initialWorkbenchSelection(new URLSearchParams("view=newTask"), papers, runs).activeTab, "newTask");
});

test("a new workspace still opens upload and a paper without results is not substituted", () => {
  assert.equal(initialWorkbenchSelection(new URLSearchParams(), [], []).activeTab, "newTask");
  const selected = initialWorkbenchSelection(new URLSearchParams("paper=empty"), papers, runs);
  assert.equal(selected.paperId, "empty");
  assert.equal(selected.runId, null);
  assert.equal(selected.activeTab, "newTask");
});

test("the sidebar targets the result-bearing run until this paper has an explicit selection", () => {
  assert.deepEqual(sidebarPaperSelection("paper-a", runs, { paperId: "paper-b", runId: "b", historyId: "" }), { runId: "old-a", historyId: "" });
  assert.deepEqual(sidebarPaperSelection("paper-a", runs, { paperId: "paper-a", runId: "new-empty-a", historyId: "" }), { runId: "new-empty-a", historyId: "" });
  assert.deepEqual(sidebarPaperSelection("paper-a", runs, { paperId: "paper-a", runId: null, historyId: "archived-a" }), { runId: null, historyId: "archived-a" });
  assert.deepEqual(sidebarPaperSelection("paper-a", runs, { paperId: "paper-a", runId: "b", historyId: "" }), { runId: "old-a", historyId: "" });
  assert.deepEqual(sidebarPaperSelection("empty", runs, { paperId: "paper-b", runId: "b", historyId: "" }), { runId: null, historyId: "" });
});
