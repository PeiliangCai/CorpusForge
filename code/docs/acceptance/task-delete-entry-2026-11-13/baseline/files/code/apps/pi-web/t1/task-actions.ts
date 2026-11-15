import type { WorkbenchRun } from "../../../packages/contracts/src/workbench";

// Native reconciliation is cancellable. The API also uses this state during
// terminal finalization, so the cancel response decides the actual outcome.
const cancellable = new Set(["queued", "parsing", "extracting", "reconciling"]);
const ended = new Set(["completed", "partial", "failed", "interrupted"]);

export function canCancelRun(run: Pick<WorkbenchRun, "state">) {
  return cancellable.has(run.state);
}

/** A paper's displayed result can be older than its running tasks. */
export function cancellablePaperRuns(paperId: string, runs: WorkbenchRun[]) {
  return runs.filter(run => run.document_id === paperId && canCancelRun(run))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || a.run_id.localeCompare(b.run_id));
}

export function cancellationResult(state: string) {
  if (state === "cancelled") return "cancelDone";
  if (ended.has(state)) return "cancelEnded";
  // The API also reports reconciling while a completed task finishes saving.
  // cancel() preserves that terminal task: a 200 response alone is not success.
  if (state === "reconciling") return "cancelFinalizing";
  return "cancelUnconfirmed";
}
