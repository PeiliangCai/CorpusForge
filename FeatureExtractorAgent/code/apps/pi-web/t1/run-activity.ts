import type { WorkbenchRun } from "../../../packages/contracts/src/workbench";
import { runPresentation } from "./run-presentation";

// Three existing ten-second detail polling intervals. This describes the
// freshness of our observations, never a provider timeout or a cancellation.
export const ACTIVITY_FRESH_MS = 30_000;
const quotaReasons = new Set(["experiment_input_token_limit", "experiment_output_token_limit", "experiment_request_limit"]);
const timeReasons = new Set(["experiment_time_limit", "document_time_limit", "request_time_limit", "pi_session_time_limit"]);
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Host operation receipts and successful detail reads are the authority.
 * A clock, SSE keepalive or progress percentage cannot prove model activity. */
export function runActivity(run: WorkbenchRun | undefined, state: string | undefined, connection?: string, observedAt?: number, now?: number | null) {
  const presentation = runPresentation(state, run, run?.result_ready, run?.task_completion);
  const reason = run?.progress?.termination_reason;
  const terminationReason = ["partial", "failed"].includes(state ?? "") && run?.result_ready === true && typeof reason === "string" && (quotaReasons.has(reason) || timeReasons.has(reason)) ? reason : undefined;
  const stopped = ["cancelled", "failed", "interrupted"].includes(state ?? "") || Boolean(terminationReason);
  const terminal = presentation.ended;
  const operation = terminal ? undefined : run?.progress?.operation;
  const validOperation = operation && Number.isFinite(Date.parse(operation.started_at)) && count(operation.elapsed_ms) !== undefined
    && (operation.kind === "model_request" && ["waiting_response", "receiving_response"].includes(operation.state)
      || operation.kind === "tool" && operation.state === "executing" || operation.kind === "retry" && operation.state === "scheduled") ? operation : undefined;
  const phase = validOperation?.kind === "model_request" ? validOperation.state === "waiting_response" ? "waiting" : "receiving"
    : validOperation?.kind === "tool" ? "tool" : validOperation?.kind === "retry" ? "retry" : "processing";
  const age = typeof observedAt === "number" && Number.isFinite(observedAt) && typeof now === "number" && Number.isFinite(now) ? Math.max(0, now - observedAt) : undefined;
  const freshness = connection !== "connected" ? "disconnected" : age === undefined || age > ACTIVITY_FRESH_MS ? "stale" : "live";
  const status = stopped ? "stopped" : presentation.finalizing ? "finalizing" : terminal ? "ended" : freshness === "live" ? phase : freshness;
  const elapsedMs = validOperation ? validOperation.elapsed_ms + (freshness === "live" ? age! : 0) : undefined;
  const index = terminal || state !== "extracting" ? undefined : count(run?.progress?.current_batch_index), total = count(run?.progress?.total_batches);
  return { status, phase, stopped, terminal, freshness, elapsedMs, operation: validOperation, terminationReason,
    stopKind: terminationReason ? quotaReasons.has(terminationReason) ? "quota" : "time" : undefined,
    currentBatchIndex: index !== undefined && index > 0 && (total === undefined || index <= total) ? index : undefined,
    failedBatches: count(run?.progress?.failed_batches), lastRequest: run?.progress?.last_request };
}
