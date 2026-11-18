import type { WorkbenchRun } from "../../../packages/contracts/src/workbench";
import { runPresentation } from "./run-presentation";

export const progressStages = ["queued", "parsing", "extracting", "reconciling", "completed"] as const;
type ActiveStage = typeof progressStages[number];
export interface ProgressEvent { type: string; stage?: string; timestamp: string; detail?: Record<string, unknown> }
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const activeStage = (value: unknown): value is ActiveStage => progressStages.includes(value as ActiveStage);

/** Keep only the last state/inventory and one small receipt per extraction
 * window. Large tool diagnostics can leave the 500-event reader log without
 * erasing already observed work or retaining model payloads in this snapshot. */
export function retainProgressEvent(previous: readonly ProgressEvent[], event: ProgressEvent): readonly ProgressEvent[] {
  const detail = object(event.detail);
  if (event.type === "state") {
    const live = (state: unknown) => activeStage(state) && state !== "completed";
    return [...previous.filter(item => item.type !== "state" || live(item.detail?.state ?? item.stage) !== live(detail.state ?? event.stage)), { type: event.type, timestamp: event.timestamp, stage: event.stage, detail: { state: detail.state } }];
  }
  if (event.type === "coverage_inventory") return [...previous.filter(item => item.type !== "coverage_inventory"), { type: event.type, timestamp: event.timestamp, detail: { dispatched_blocks: detail.dispatched_blocks, progress_unit: detail.progress_unit, total_paragraphs: detail.total_paragraphs, total_content_units: detail.total_content_units } }];
  if (event.type !== "batch" || !Array.isArray(detail.assigned_block_ids)) return previous;
  const ids = detail.assigned_block_ids.filter((id): id is string => typeof id === "string");
  const sameBatch = (item: ProgressEvent) => item.type === "batch" && (typeof detail.batch_id === "string" ? item.detail?.batch_id === detail.batch_id : JSON.stringify(item.detail?.assigned_block_ids) === JSON.stringify(ids));
  return [...previous.filter(item => !sameBatch(item)), { type: event.type, timestamp: event.timestamp, detail: { batch_id: detail.batch_id, assigned_block_ids: ids, status: detail.status, explicit_completion_received: detail.explicit_completion_received, completed_paragraph_ids: detail.completed_paragraph_ids, completed_content_unit_ids: detail.completed_content_unit_ids } }];
}

/** Counts are source work completed by the host. A summary reread is never completion. */
export function runProgress(run: WorkbenchRun | undefined, state: string | undefined, coverage: unknown, events: readonly ProgressEvent[]) {
  const saved = object(coverage), telemetry = run?.progress;
  const persisted = runPresentation(state, coverage, run?.result_ready, run?.task_completion);
  const ended = persisted.ended && !persisted.finalizing;
  // The saved run wins over a replayed terminal/state event. New live events can
  // advance an active task while its detail request is still in flight.
  const latestState = [...events].reverse().find(event => activeStage(event.detail?.state ?? event.stage) && (event.detail?.state ?? event.stage) !== "completed");
  const observed = latestState?.detail?.state ?? latestState?.stage;
  const base = activeStage(telemetry?.stage) && telemetry?.stage !== "completed" ? telemetry.stage : activeStage(state) && state !== "completed" ? state : "queued";
  const stage = persisted.finalizing ? "reconciling" : ended ? state! : activeStage(observed) && progressStages.indexOf(observed) > progressStages.indexOf(base) ? observed : base;
  const lastActive = [...events].reverse().map(event => event.detail?.state ?? event.stage).find(value => activeStage(value) && value !== "completed");
  const success = persisted.taskComplete;
  const phase = activeStage(stage) ? stage : activeStage(lastActive) ? lastActive : undefined;
  const stageIndex = success ? 4 : phase && phase !== "completed" ? progressStages.indexOf(phase) : -1;

  let completed = count(telemetry?.completed), total = count(telemetry?.total);
  const inventory = [...events].reverse().find(event => event.type === "coverage_inventory");
  const unit = telemetry?.unit ?? (saved.progress_unit === "content_units" || inventory?.detail?.progress_unit === "content_units" ? "content_units" : saved.progress_unit === "paragraphs" || inventory?.detail?.progress_unit === "paragraphs" ? "paragraphs" : "source_blocks");
  if (total === undefined) total = count(unit === "content_units" ? saved.dispatched_content_units : unit === "paragraphs" ? saved.dispatched_paragraphs : saved.dispatched_source_blocks);
  if (completed === undefined) completed = count(unit === "content_units" ? saved.explicitly_completed_content_units : unit === "paragraphs" ? saved.explicitly_completed_paragraphs : saved.explicitly_completed_source_blocks);
  const eventTotal = count(unit === "content_units" ? inventory?.detail?.total_content_units : unit === "paragraphs" ? inventory?.detail?.total_paragraphs : inventory?.detail?.dispatched_blocks);
  if (total === undefined) total = eventTotal;
  const ids = new Set<string>();
  for (const event of events) if (event.type === "batch" && event.detail?.status === "completed" && event.detail.explicit_completion_received !== false && Array.isArray(event.detail.assigned_block_ids)) {
    const done = unit === "content_units" ? event.detail.completed_content_unit_ids : unit === "paragraphs" ? event.detail.completed_paragraph_ids : event.detail.assigned_block_ids;
    if (Array.isArray(done)) for (const id of done) if (typeof id === "string") ids.add(id);
  }
  if (total !== undefined && (eventTotal === undefined || eventTotal === total) && (inventory || ids.size > 0) && ids.size <= total) {
    // A new SSE receipt may arrive before the coalesced run-detail read.
    // Same-run proved work can advance an older snapshot, never lower it.
    completed = Math.max(completed ?? 0, ids.size);
  }
  const counted = completed !== undefined && total !== undefined && total > 0 && completed <= total;
  // A percent belongs only to extraction work. Summary, partial and failed
  // outcomes never turn a completed source-block count into task success.
  const percent = !ended && stage === "extracting" && counted ? Math.floor(completed! / total! * 100) : undefined;
  const gap = Array.isArray(saved.quarantined_source_block_ids) ? saved.quarantined_source_block_ids.length : undefined;
  const updatedAt = telemetry?.updated_at ?? events.at(-1)?.timestamp;
  return { stage, phase, stageIndex, ended, success, finalizing: persisted.finalizing, unit, completed: counted ? completed : undefined, total: counted ? total : undefined,
    percent, gap, updatedAt, activity: telemetry?.activity, candidateRecords: count(telemetry?.candidate_records) ?? count(run?.candidate_count) ?? 0,
    completedBatches: count(telemetry?.completed_batches), totalBatches: count(telemetry?.total_batches),
    executionElapsedMs: count(telemetry?.execution_elapsed_ms), queueWaitMs: count(telemetry?.queue_wait_ms ?? run?.queue_wait_ms) };
}

export const contentUnitKinds = ["paragraph", "caption", "heading", "table_row", "figure_text", "list_item", "footnote", "text_item", "source_fragment"] as const;
/** Display only recorded classification counts; legacy totals cannot tell us
 * how many natural body paragraphs, figure labels or fallback fragments exist. */
export function contentUnitComposition(progress: unknown) {
  const value = object(progress), totals = object(value.unit_counts), done = object(value.completed_unit_counts);
  return contentUnitKinds.flatMap(kind => {
    const total = count(totals[kind]), completed = count(done[kind]);
    return total === undefined || total === 0 ? [] : [{ kind, total, completed: completed !== undefined && completed <= total ? completed : undefined }];
  });
}

export function progressDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000)), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  return hours ? `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
