"use client";

import { useI18n } from "@/hooks/useI18n";
import type { WorkbenchRun } from "../../../packages/contracts/src/workbench";
import { progressDuration } from "./run-progress";

/** Technical identity, retries and error codes stay inside the notes drawer. */
export function RunActivityDetails({ run }: { run: WorkbenchRun }) {
  const { t, locale } = useI18n(), saved = run.progress, terminal = ["completed", "partial", "cancelled", "failed", "interrupted"].includes(run.state);
  const operation = terminal ? undefined : saved?.operation, request = saved?.last_request;
  if (!operation && !request) return null;
  const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale) : t("t1.timeUnrecorded");
  return <details className="t1-technical-details t1-operation-details"><summary>{t("t1.progressActivityDetails")}</summary>
    {operation && <><p>{t(`t1.activity_${operation.kind === "model_request" ? operation.state === "waiting_response" ? "waiting" : "receiving" : operation.kind === "tool" ? "tool" : "retry"}`)} · {t("t1.progressOperationElapsed", { time: progressDuration(operation.elapsed_ms) })}</p><p>{t("t1.progressOperationStarted", { time: date(operation.started_at) })}</p>
      {operation.attempt !== undefined && <p>{t("t1.progressRequestAttempt", { attempt: operation.attempt + 1, total: (operation.max_retries ?? operation.attempt) + 1 })}</p>}{operation.tool_name && <code>{operation.tool_name}</code>}</>}
    {request && <p>{t(request.outcome === "failed" ? "t1.progressLastRequestFailed" : "t1.progressLastResponse", { time: date(request.finished_at) })}{request.error_code && <> · <code>{request.error_code}</code></>}</p>}
    <p>{t("t1.progressActivityHelp")}</p>
  </details>;
}
