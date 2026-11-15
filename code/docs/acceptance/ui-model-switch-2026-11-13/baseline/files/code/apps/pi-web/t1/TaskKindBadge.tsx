"use client";

import { useI18n } from "@/hooks/useI18n";
import type { WorkbenchSubmission } from "../../../packages/contracts/src/workbench";

export const taskKindKey = (kind?: WorkbenchSubmission["kind"]) => kind === "single" ? "t1.taskSingle" : kind === "batch" ? "t1.taskBatch" : "t1.taskKindUnrecorded";

export function TaskKindBadge({ kind }: { kind?: WorkbenchSubmission["kind"] }) {
  const { t } = useI18n();
  return <span className="t1-task-kind" data-task-kind={kind ?? "unrecorded"}>{t(taskKindKey(kind))}</span>;
}
