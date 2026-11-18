"use client";

import { useI18n } from "@/hooks/useI18n";
import type { WorkbenchPaper, WorkbenchRun } from "../../../packages/contracts/src/workbench";
import { batchProgress } from "./batch-progress";
import { DetailDisclosure } from "./DetailDisclosure";
import { originalRunFilename } from "./task-titles";

export function BatchProgress({ batchId, runs, papers, runLabel }: { batchId: string; runs: readonly WorkbenchRun[]; papers: readonly WorkbenchPaper[]; runLabel: (run: WorkbenchRun) => string }) {
  const { t } = useI18n(), progress = batchProgress(runs);
  const endedText = t("t1.batchEndedCount", { count: progress.ended, total: progress.total });
  const progressText = progress.percent === undefined ? endedText : t("t1.batchEndedPercent", { count: progress.ended, total: progress.total, percent: progress.percent });
  return <section className="t1-run-progress t1-batch-overview" aria-label={t("t1.batchProgress")} data-batch-results={batchId} data-progress-outcome={progress.allComplete ? "complete" : progress.allEnded ? "incomplete" : "active"}>
    <div className="t1-progress-heading"><strong>{t("t1.batchProgress")}</strong><div className="t1-progress-metrics"><span>{t("t1.progressCandidates", { count: progress.candidates })}</span></div></div>
    <p>{t("t1.batchResultsHelp", { count: progress.total })}</p>
    <p className="t1-batch-ended" aria-live="polite">{progressText}</p>
    <ol className="t1-progress-stages t1-batch-stages">{progress.stages.map(({ stage, count }, index) => <li key={stage} data-stage={stage} data-step={count ? stage === "completed" ? progress.allComplete ? "done" : progress.allEnded ? "stopped" : "current" : "current" : "pending"}><span>{index + 1}</span><div>{t(stage === "completed" ? "t1.progress_ended" : `t1.progress_${stage}`)}<small>{t("t1.batchStagePapers", { count })}</small></div></li>)}</ol>
    <div className="t1-progress-track" role="progressbar" aria-label={t("t1.batchEndedProgress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-valuetext={progressText}><span style={{ width: `${progress.percent ?? 0}%` }} /></div>
    <div className="t1-progress-detail t1-batch-outcomes">{progress.outcomes.map(({ status, count }) => <span key={status}>{t(`t1.${status}`)} {count}</span>)}{progress.finishing > 0 && <span>{t("t1.batchFinishing", { count: progress.finishing })}</span>}{progress.unknownState > 0 && <span>{t("t1.batchStateUnknown", { count: progress.unknownState })}</span>}</div>
    <p className="t1-batch-progress-help">{t("t1.batchEndedHelp")}</p>
    <DetailDisclosure key={batchId} title={t("t1.batchMembers")}><p>{t("t1.batchResultsHelp", { count: progress.total })}</p><ul className="t1-batch-members">{runs.map(run => <li key={run.run_id} data-batch-member={run.run_id}><span>{originalRunFilename(run, papers.find(paper => paper.id === run.document_id))}</span><span>{run.result_ready === false && !["queued", "parsing", "extracting", "reconciling"].includes(run.state) ? t("t1.batchFinishing", { count: 1 }) : runLabel(run)}</span><small>{t("t1.recordCount", { count: run.candidate_count })}</small></li>)}</ul></DetailDisclosure>
  </section>;
}
