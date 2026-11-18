import type { WorkbenchRun } from "../../../packages/contracts/src/workbench";
import { canCancelRun } from "./task-actions";
import { runPresentation } from "./run-presentation";

export interface SubmissionGroup {
  id: string;
  kind: "single" | "batch" | "unrecorded";
  runs: WorkbenchRun[];
  createdAt?: string;
  taskTitle?: string;
}

export const submittedTaskId = (run: WorkbenchRun) => run.submission?.kind === "batch" ? `batch:${run.submission.batch_id}` : `run:${run.run_id}`;
export const resultRecordKey = (record: { run_id: string; id: string }) => JSON.stringify([record.run_id, record.id]);

/** A batch is complete only when every admitted member has persisted completion. */
export function submissionRun(group: SubmissionGroup): WorkbenchRun {
  const first = group.runs[0]!;
  if (group.kind !== "batch") return first;
  const active = group.runs.filter(run => canCancelRun(run) || run.result_ready === false), endedStates = group.runs.map(run => run.state);
  const complete = group.runs.every(run => run.result_ready !== false && runPresentation(run.state, run).taskComplete);
  const incomplete = group.runs.some(run => run.task_processing_complete === false || ["failed", "cancelled", "interrupted"].includes(run.state));
  const state = active.length ? ["queued", "parsing", "extracting", "reconciling"].find(stage => active.some(run => run.state === stage)) ?? "reconciling"
    : complete ? "completed" : endedStates.every(state => state === "cancelled") ? "cancelled"
    : endedStates.every(state => state === "failed") ? "failed" : endedStates.every(state => state === "interrupted") ? "interrupted" : "partial";
  const sum = (key: "completed" | "total" | "completed_batches" | "total_batches" | "source_gap_blocks") => {
    if (["completed", "total"].includes(key) && new Set(group.runs.map(run => run.progress?.unit ?? "source_blocks")).size > 1) return undefined;
    const counts = group.runs.map(run => key === "source_gap_blocks" ? run.task_completion?.source_gap_blocks ?? run.progress?.[key] : run.progress?.[key]);
    return counts.every((count): count is number => typeof count === "number") ? counts.reduce((n, count) => n + count, 0) : undefined;
  };
  return { ...first, run_id: group.id, state, candidate_count: group.runs.reduce((count, run) => count + run.candidate_count, 0),
    task_processing_complete: complete ? true : incomplete ? false : undefined, task_completion: undefined, result_ready: group.runs.every(run => run.result_ready !== false),
    progress: { schema_version: "t1-workbench-progress-1", stage: state as NonNullable<WorkbenchRun["progress"]>["stage"], candidate_records: group.runs.reduce((n, run) => n + run.candidate_count, 0),
      unit: group.runs.every(run => run.progress?.unit === "paragraphs") ? "paragraphs" : "source_blocks",
      completed: sum("completed"), total: sum("total"), completed_batches: sum("completed_batches"), total_batches: sum("total_batches"), source_gap_blocks: sum("source_gap_blocks"),
      summary_completed: group.runs.every(run => run.progress?.summary_completed === true), telemetry: group.runs.every(run => run.progress?.telemetry === "events") ? "events" : "unavailable" },
    execution_started_at: undefined, finished_at: undefined };
}

/** Only admitted runs enter this view. Missing metadata never invents a batch. */
export function groupSubmittedRuns(runs: readonly WorkbenchRun[]): SubmissionGroup[] {
  const groups = new Map<string, SubmissionGroup>();
  for (const run of runs) {
    const batch = run.submission?.kind === "batch" ? run.submission.batch_id : undefined;
    const id = batch ? `batch:${batch}` : `run:${run.run_id}`;
    let group = groups.get(id);
    if (!group) { group = { id, kind: batch ? "batch" : run.submission?.kind === "single" ? "single" : "unrecorded", runs: [], createdAt: run.created_at, ...(batch && run.task_title ? { taskTitle: run.task_title } : {}) }; groups.set(id, group); }
    group.runs.push(run);
    if ((run.created_at ?? "") > (group.createdAt ?? "")) group.createdAt = run.created_at;
  }
  return [...groups.values()].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}
