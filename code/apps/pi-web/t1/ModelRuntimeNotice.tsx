"use client";
import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { WorkbenchModelRuntime } from "../../../packages/contracts/src/workbench";
import { WorkbenchNotes } from "./WorkbenchNotes";

export function ModelRuntimeNotice({ runtime, maxConcurrent, showModel = true }: { runtime?: WorkbenchModelRuntime; maxConcurrent?: number; showModel?: boolean }) {
  const { t, locale } = useI18n();
  const [showBudget, setShowBudget] = useState(false);
  if (!runtime) return null;
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const seconds = runtime.limits.execution_seconds;
  return <aside className="t1-model-runtime" role="note">
    {showModel && <p><strong>{runtime.model_id} · {runtime.reasoning_effort}</strong></p>}
    <p>{t("t1.paidStartOnly")}</p>
    <button type="button" className="t1-button" aria-haspopup="dialog" aria-expanded={showBudget} onClick={() => setShowBudget(true)}>{t("t1.runBudget")}</button>
    <WorkbenchNotes variant="creation" open={showBudget} title={t("t1.runBudget")} onClose={() => setShowBudget(false)} footer={<button type="button" className="t1-button" onClick={() => setShowBudget(false)}>{t("t1.close")}</button>}>
      <div className="t1-model-budget"><p className="t1-budget-model"><strong>{runtime.model_id}</strong><span>{runtime.provider} · {runtime.reasoning_effort}</span></p><dl>
      <dt>{t("t1.requestLimit")}</dt><dd>{number(runtime.limits.requests)}</dd>
      <dt>{t("t1.inputTokenLimit")}</dt><dd>{number(runtime.limits.input_tokens)}</dd>
      <dt>{t("t1.outputTokenLimit")}</dt><dd>{number(runtime.limits.output_tokens)}</dd>
      <dt>{t("t1.executionLimit")}</dt><dd>{number(seconds % 60 === 0 ? seconds / 60 : seconds)} {t(seconds % 60 === 0 ? "t1.minutesShort" : "t1.secondsShort")}</dd>
      {maxConcurrent !== undefined && <><dt>{t("t1.concurrentLimit")}</dt><dd>{number(maxConcurrent)}</dd></>}
      </dl><p>{t("t1.queueOutsideExecutionLimit")}</p></div>
    </WorkbenchNotes>
  </aside>;
}
