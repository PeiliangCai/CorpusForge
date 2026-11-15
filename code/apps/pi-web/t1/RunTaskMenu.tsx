"use client";

import { SidebarMenu, type SidebarMenuAnchor, type SidebarMenuItem } from "@/components/SidebarMenu";
import { CloseIcon, MessageIcon, TrashIcon } from "@/components/SidebarIcons";
import { useI18n } from "@/hooks/useI18n";
import type { WorkbenchPaper, WorkbenchRun } from "../../../packages/contracts/src/workbench";
import { canCancelRun } from "./task-actions";
import { taskDisplayTitle } from "./task-titles";

export interface RunTaskMenuState { runId: string; paperId: string; anchor: SidebarMenuAnchor; opener: HTMLButtonElement }
export function RunTaskMenu({ menu, run, paper, members = [], cancelling, mobile, onClose, onCancel, onView, onDelete }: {
  menu: RunTaskMenuState | null; run?: WorkbenchRun; paper?: WorkbenchPaper;
  members?: WorkbenchRun[];
  cancelling: ReadonlySet<string>; mobile: boolean; onClose(): void;
  onCancel(run: WorkbenchRun): void; onView(run: WorkbenchRun): void; onDelete(run: WorkbenchRun, opener?: HTMLButtonElement): void;
}) {
  const { t, locale } = useI18n();
  const batch = run?.submission?.kind === "batch", cancellable = members.length ? members.some(canCancelRun) : run && canCancelRun(run), busy = members.length ? members.some(run => cancelling.has(run.run_id)) : run && cancelling.has(run.run_id);
  const items: SidebarMenuItem[] = [
    { type: "header", id: "title", label: batch ? run?.task_title ?? t("t1.taskBatch") : run ? taskDisplayTitle(run, paper) : t("t1.task") },
    { type: "custom", id: "identity", content: <p className="t1-task-menu-identity">{run?.created_at ? new Date(run.created_at).toLocaleString(locale) : t("t1.timeUnrecorded")}<br />{run?.model_id ?? t("t1.modelUnrecorded")} · #{run?.submission?.kind === "batch" ? run.submission.batch_id.slice(-8) : run?.run_id.slice(-8)}{batch && <><br />{t("t1.batchPaperCount", { count: members.length })}</>}</p> },
    { type: "item", id: "view", label: t("t1.viewExtraction"), icon: <MessageIcon size={14} />, disabled: !run, onSelect: () => { if (run) onView(run); } },
    ...(run && cancellable ? [{ type: "item" as const, id: "cancel", label: t(busy ? "t1.cancelling" : batch ? "t1.cancelBatch" : "t1.cancel"), icon: <CloseIcon size={14} />, disabled: Boolean(busy), onSelect: () => onCancel(run) }] : []),
    { type: "separator", id: "delete-separator" },
    { type: "item", id: "delete", label: t("t1.deleteRun"), icon: <TrashIcon size={14} />, danger: true, disabled: !run, onSelect: () => { if (run) onDelete(run, menu?.opener); } },
  ];
  return <SidebarMenu open={menu !== null} anchor={menu?.anchor ?? null} returnFocusTo={menu?.opener} sheet={mobile} ariaLabel={t("t1.taskActions")} title={t("t1.taskActions")} cancelLabel={t("t1.close")} width={320} items={items} onClose={onClose} />;
}
