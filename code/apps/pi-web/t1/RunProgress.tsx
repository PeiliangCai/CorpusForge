"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { WorkbenchRun } from "../../../packages/contracts/src/workbench";
import { progressDuration, progressStages, runProgress, type ProgressEvent } from "./run-progress";
import { runPresentation } from "./run-presentation";
import { runActivity } from "./run-activity";

/** The clock only updates elapsed time. Percentages change with persisted work. */
export function RunProgress({ run, state, coverage, events, connection, observedAt, onDetails }: { run?: WorkbenchRun; state?: string; coverage: unknown; events: readonly ProgressEvent[]; connection?: string; observedAt?: number; onDetails(): void }) {
  const { t, locale } = useI18n();
  const progress = runProgress(run, state, coverage, events), presentation = runPresentation(state, coverage, run?.result_ready, run?.task_completion);
  const [now, setNow] = useState<number | null>(null);
  const activity = runActivity(run, state, connection, observedAt, now ?? observedAt);
  useEffect(() => {
    if (progress.ended || activity.stopped) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [progress.ended, activity.stopped]);
  const started = run?.execution_started_at ? Date.parse(run.execution_started_at) : NaN;
  const finished = run?.finished_at ? Date.parse(run.finished_at) : NaN;
  const eventAt = progress.updatedAt ? Date.parse(progress.updatedAt) : NaN;
  const executionMs = Number.isFinite(started) && (progress.ended ? Number.isFinite(finished) : now !== null)
    ? Math.max(0, (progress.ended ? finished : now!) - started) : progress.executionElapsedMs;
  const queuedAt = run?.created_at ? Date.parse(run.created_at) : NaN;
  const queueMs = progress.stage === "queued" && now !== null && Number.isFinite(queuedAt) ? Math.max(0, now - queuedAt) : progress.queueWaitMs;
  const active = !progress.ended && !activity.stopped, determinate = progress.percent !== undefined;
  const percentKey = progress.unit === "source_blocks" ? "t1.progressSourcePercent" : "t1.progressParagraphPercent", countKey = progress.unit === "source_blocks" ? "t1.progressSourceCount" : "t1.progressParagraphCount";
  const stageLabel = t(`t1.${activity.stopped ? state : progress.ended || progress.finalizing ? presentation.statusKey : `progress_${progress.stage}`}`);
  const activityText = activity.status === "stopped" ? t(activity.stopKind === "quota" ? "t1.progressStoppedQuota" : activity.stopKind === "time" ? "t1.progressStoppedTime" : "t1.progressStopped") : activity.status === "ended" ? progress.success ? t("t1.progressFinished") : t("t1.progressEnded")
    : activity.status === "finalizing" ? t("t1.taskFinalizingHint") : activity.status === "stale" || activity.status === "disconnected" ? t(`t1.activity_${activity.status}`, { activity: t(`t1.activity_${activity.phase}`) }) : t(`t1.activity_${activity.status}`);
  return <section className="t1-run-progress" data-progress-stage={progress.stage} data-progress-outcome={progress.success ? "complete" : progress.ended || activity.stopped ? "incomplete" : "active"} aria-label={t("t1.extractionProgress")}>
    <div className="t1-progress-heading"><button className="t1-progress-title" onClick={onDetails}><span className="t1-status-dot" />{stageLabel}</button>
      <div className="t1-progress-metrics">{executionMs !== undefined ? <span>{t("t1.progressElapsed", { time: progressDuration(executionMs) })}</span> : progress.ended && <span>{t("t1.progressElapsedUnrecorded")}</span>}{progress.stage === "queued" && queueMs !== undefined && <span>{t("t1.progressQueueElapsed", { time: progressDuration(queueMs) })}</span>}<span>{t("t1.progressCandidates", { count: progress.candidateRecords })}</span></div>
    </div>
    <p className="t1-progress-activity" data-activity-status={activity.status} role="status" title={activityText}>{activity.stopped ? <strong>{activityText}</strong> : activityText}{activity.elapsedMs !== undefined && <> · {t(activity.freshness === "live" ? "t1.progressOperationElapsed" : "t1.progressRecordedElapsed", { time: progressDuration(activity.elapsedMs) })}</>}{activity.stopped && progress.finalizing && <> · {t("t1.progressStoppedSaving")}</>}</p>
    <ol className="t1-progress-stages">{progressStages.map((stage, index) => <li key={stage} data-step={progress.success || progress.stageIndex > index ? "done" : progress.stageIndex === index ? active ? "current" : "stopped" : "pending"} aria-current={active && progress.stageIndex === index ? "step" : undefined}><span>{index + 1}</span>{t(`t1.progress_${stage}`)}</li>)}</ol>
    <div className={`t1-progress-track${active && !determinate ? " is-indeterminate" : ""}`} role="progressbar" aria-label={t(determinate ? "t1.progressSourceStage" : "t1.extractionProgress")} aria-valuemin={determinate || progress.success ? 0 : undefined} aria-valuemax={determinate || progress.success ? 100 : undefined} aria-valuenow={progress.success ? 100 : progress.percent} aria-valuetext={determinate ? t(percentKey, { completed: progress.completed!, total: progress.total!, percent: progress.percent! }) : stageLabel}>
      <span style={determinate ? { width: `${progress.percent}%` } : progress.success ? { width: "100%" } : undefined} />
    </div>
    <div className="t1-progress-detail" aria-live="polite"><span>{progress.percent !== undefined ? t(percentKey, { completed: progress.completed!, total: progress.total!, percent: progress.percent }) : progress.completed !== undefined ? t(countKey, { completed: progress.completed, total: progress.total! }) : t(active ? "t1.progressUnknownTotal" : "t1.progressNoCount")}</span>{active && progress.stage === "reconciling" && <span>{t(progress.finalizing ? "t1.taskFinalizingHint" : "t1.progressSummaryHelp")}</span>}{active && progress.activity === "figure_discovery" && <span>{t("t1.progressFiguresActivity")}</span>}{activity.currentBatchIndex !== undefined && <span>{t("t1.progressCurrentBatch", { index: activity.currentBatchIndex })}</span>}{progress.totalBatches !== undefined && <span>{t("t1.progressBatchCount", { completed: progress.completedBatches ?? 0, total: progress.totalBatches })}</span>}{Boolean(activity.failedBatches) && <span>{t("t1.progressFailedBatches", { count: activity.failedBatches! })}</span>}</div>
    {Boolean(progress.gap) && <p className="t1-progress-gap">{t("t1.progressScopeGap", { count: progress.gap! })}</p>}
    {Number.isFinite(eventAt) && <time className="t1-progress-updated" dateTime={progress.updatedAt}>{t("t1.progressLastUpdate", { time: new Date(eventAt).toLocaleTimeString(locale, { hour12: false }) })}</time>}
  </section>;
}
