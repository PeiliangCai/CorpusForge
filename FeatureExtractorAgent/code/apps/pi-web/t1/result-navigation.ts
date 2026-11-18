import type { WorkbenchPaper, WorkbenchRun } from "../../../packages/contracts/src/workbench";

const views = ["newTask", "records", "figures", "tasks"];

export function hasWorkbenchTaskContext(selection: { runId: string | null; historyId: string; paperId: string }, papers: readonly WorkbenchPaper[], runs: readonly WorkbenchRun[]) {
  if (selection.runId) return runs.some(run => run.run_id === selection.runId);
  return Boolean(selection.historyId && papers.some(paper => paper.id === selection.paperId && paper.output_ids.includes(selection.historyId)));
}

/** Global pages never inherit a paper. Task pages require an explicit existing
 * run or saved history identity; an orphaned PDF cannot create task context. */
export function initialWorkbenchSelection(params: URLSearchParams, papers: WorkbenchPaper[], runs: WorkbenchRun[]) {
  const view = params.get("view"), globalView = view === "newTask" || view === "tasks";
  const requestedRunId = params.get("run"), requestedHistoryId = requestedRunId ? "" : params.get("history") ?? "";
  const linkedRun = globalView ? undefined : runs.find(run => run.run_id === (requestedRunId || requestedHistoryId));
  const linkedPaper = papers.find(paper => paper.id === params.get("paper"));
  const historyId = !globalView && !linkedRun && !requestedRunId && linkedPaper?.output_ids.includes(requestedHistoryId) ? requestedHistoryId : "";
  const hasContext = Boolean(linkedRun || historyId);
  return {
    paperId: linkedRun?.document_id ?? (historyId ? linkedPaper!.id : ""),
    runId: linkedRun?.run_id ?? null,
    historyId,
    recordId: hasContext ? params.get("record") ?? "" : "",
    activeTab: globalView ? view! : hasContext ? views.includes(view ?? "") ? view! : "records" : "newTask",
  };
}

export function workbenchSelectionParams(selection: { paperId: string; runId: string | null; historyId: string; recordId: string; activeTab: string }) {
  const params = new URLSearchParams();
  if ((selection.activeTab === "records" || selection.activeTab === "figures") && (selection.runId || selection.historyId)) {
    if (selection.paperId) params.set("paper", selection.paperId);
    if (selection.runId) params.set("run", selection.runId); else params.set("history", selection.historyId);
    if (selection.recordId) params.set("record", selection.recordId);
  }
  params.set("view", selection.activeTab);
  return params;
}
