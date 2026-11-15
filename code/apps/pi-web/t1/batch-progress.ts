import type { WorkbenchRun } from "../../../packages/contracts/src/workbench";
import { progressStages } from "./run-progress";
import { runPresentation } from "./run-presentation";

/** The fraction measures ended, saved papers only. Source blocks, summary
 * receipts, selected-record SSE and candidate counts cannot advance it. */
export function batchProgress(runs: readonly WorkbenchRun[]) {
  const endedRuns = runs.filter(run => runPresentation(run.state, run).ended && run.result_ready !== false);
  const complete = endedRuns.filter(run => runPresentation(run.state, run).taskComplete).length;
  const stages = progressStages.map(stage => ({ stage, count: stage === "completed" ? endedRuns.length : runs.filter(run => run.state === stage).length }));
  const finishing = runs.filter(run => runPresentation(run.state, run).ended && run.result_ready === false).length;
  const unknownState = runs.length - stages.reduce((sum, stage) => sum + stage.count, 0) - finishing;
  const outcomes = new Map<string, number>();
  for (const run of endedRuns) { const key = runPresentation(run.state, run).statusKey; outcomes.set(key, (outcomes.get(key) ?? 0) + 1); }
  return { total: runs.length, ended: endedRuns.length, percent: runs.length ? Math.floor(endedRuns.length / runs.length * 100) : undefined,
    allEnded: runs.length > 0 && endedRuns.length === runs.length, allComplete: runs.length > 0 && complete === runs.length,
    stages, finishing, unknownState, outcomes: [...outcomes].map(([status, count]) => ({ status, count })),
    candidates: runs.reduce((sum, run) => sum + run.candidate_count, 0) };
}
