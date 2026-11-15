import type { WorkbenchPaper, WorkbenchRun } from "../../../packages/contracts/src/workbench";

const views = ["newTask", "records", "figures", "tasks"];

/** Prefer saved evidence when opening a paper, without altering an explicit run/history link. */
export function resultRunForPaper(paperId: string, runs: WorkbenchRun[]) {
  return runs.find(run => run.document_id === paperId && run.candidate_count > 0)
    ?? runs.find(run => run.document_id === paperId);
}

/** The sidebar label and its click target share one selection, including an explicit historical view. */
export function sidebarPaperSelection(paperId: string, runs: WorkbenchRun[], selected: { paperId: string; runId: string | null; historyId: string }) {
  if (selected.paperId === paperId) {
    const run = runs.find(item => item.run_id === selected.runId && item.document_id === paperId);
    if (run) return { runId: run.run_id, historyId: "" };
    if (!selected.runId && selected.historyId) return { runId: null, historyId: selected.historyId };
  }
  return { runId: resultRunForPaper(paperId, runs)?.run_id ?? null, historyId: "" };
}

export function initialWorkbenchSelection(params: URLSearchParams, papers: WorkbenchPaper[], runs: WorkbenchRun[]) {
  const linkedRun = runs.find(run => run.run_id === params.get("run"));
  const linkedPaper = papers.find(paper => paper.id === params.get("paper"));
  const paper = papers.find(paper => paper.id === linkedRun?.document_id)
    ?? linkedPaper
    ?? papers.find(paper => runs.some(run => run.document_id === paper.id && run.candidate_count > 0))
    ?? papers.find(paper => paper.output_ids.length > 0)
    ?? papers[0];
  const historyId = linkedRun ? "" : params.get("history") ?? "";
  const run = linkedRun ?? (historyId ? undefined : resultRunForPaper(paper?.id ?? "", runs));
  const view = params.get("view");
  return {
    paperId: paper?.id ?? "",
    runId: run?.run_id ?? null,
    historyId,
    recordId: params.get("record") ?? "",
    activeTab: views.includes(view ?? "") ? view! : run || historyId || paper?.output_ids.length ? "records" : "newTask",
  };
}
