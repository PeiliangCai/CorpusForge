"use client";

import type { WorkbenchRun, WorkbenchSourceGap } from "../../../packages/contracts/src/workbench";
import { useI18n } from "@/hooks/useI18n";
import { runPresentation } from "./run-presentation";
import { taskCompletionDetails } from "./task-completion";
import { contentUnitComposition } from "./run-progress";
import { RunActivityDetails } from "./RunActivityDetails";

export function TaskCompletionNotes({ entries }: { entries: readonly { run: WorkbenchRun; coverage: unknown; label?: string; gaps?: WorkbenchSourceGap[]; pdfUrl?: string }[] }) {
  const { t } = useI18n();
  return <section className="t1-notes-section" data-task-completion-notes>
    <h3>{t("t1.completionDetails")}</h3><p>{t("t1.completionAutomaticHelp")}</p>
    {entries.map(({ run, coverage, label }) => {
      const presentation = runPresentation(run.state, coverage ?? run, run.result_ready, run.task_completion), details = taskCompletionDetails(run, coverage);
      const composition = contentUnitComposition(run.progress), contentUnits = run.progress?.unit && run.progress.unit !== "source_blocks";
      return <div key={run.run_id} data-completion-run={run.run_id}>
        {label && <h4>{label}</h4>}<p>{t(`t1.${presentation.statusKey}`)}</p>
        <p>{t(`t1.${details.summaryComplete === true ? "completionSummaryDone" : details.summaryComplete === false ? "completionSummaryPending" : "completionSummaryUnknown"}`)}</p>
        {run.progress?.unit && <p>{t(contentUnits ? "t1.progressParagraphHelp" : "t1.progressLegacyLinesHelp")}</p>}
        {contentUnits && (composition.length ? <dl className="t1-unit-composition">{composition.map(({ kind, total, completed }) => <div key={kind}><dt>{t(`t1.inputUnit.${kind}`)}</dt><dd>{completed === undefined ? t("t1.progressUnitSubmitted", { total }) : t("t1.progressUnitProcessed", { completed, total })}</dd></div>)}</dl> : <p>{t("t1.progressCompositionUnrecorded")}</p>)}
        {run.progress?.total_batches !== undefined && <p>{t("t1.progressBatchHelp")}</p>}
        <RunActivityDetails run={run} />
        {run.task_completion?.rule_origin === "legacy_evidence_projection" && <p>{t("t1.completionLegacyProjection")}</p>}
        {presentation.finalizing && <p>{t("t1.taskFinalizingHint")}</p>}
        {details.reasonKeys.length > 0 && <ul>{details.reasonKeys.map(key => <li key={key}>{t(`t1.${key}`)}</li>)}</ul>}
      </div>;
    })}
  </section>;
}
