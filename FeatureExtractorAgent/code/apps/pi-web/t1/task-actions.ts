import type { WorkbenchRun } from "../../../packages/contracts/src/workbench";
import { runPresentation } from "./run-presentation";

// Native reconciliation is cancellable. The API also uses this state during
// terminal finalization, so the cancel response decides the actual outcome.
const cancellable = new Set(["queued", "parsing", "extracting", "reconciling"]);
const ended = new Set(["completed", "partial", "failed", "interrupted"]);

export function canCancelRun(run: Pick<WorkbenchRun, "state">) {
  return cancellable.has(run.state);
}

/** Only the selected task's members can block its logical deletion. Shared
 * source cleanup is coordinated separately by the server. */
export function runDeletionBlocked(run: Pick<WorkbenchRun, "state" | "result_ready">) {
  return !runPresentation(run.state, {}).ended || run.result_ready === false;
}

export function cancellationResult(state: string) {
  if (state === "cancelled") return "cancelDone";
  if (ended.has(state)) return "cancelEnded";
  // The API also reports reconciling while a completed task finishes saving.
  // cancel() preserves that terminal task: a 200 response alone is not success.
  if (state === "reconciling") return "cancelFinalizing";
  return "cancelUnconfirmed";
}
