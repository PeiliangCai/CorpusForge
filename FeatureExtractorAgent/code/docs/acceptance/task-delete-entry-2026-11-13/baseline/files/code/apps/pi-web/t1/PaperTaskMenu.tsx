"use client";

import { SidebarMenu, type SidebarMenuAnchor, type SidebarMenuItem } from "@/components/SidebarMenu";
import { CloseIcon, MessageIcon } from "@/components/SidebarIcons";
import { useI18n } from "@/hooks/useI18n";
import type { WorkbenchPaper, WorkbenchRun } from "../../../packages/contracts/src/workbench";
import { cancellablePaperRuns } from "./task-actions";

export interface PaperTaskMenuState {
  paperId: string;
  anchor: SidebarMenuAnchor;
  opener: HTMLButtonElement;
}

export function PaperTaskMenu({ menu, paper, runs, cancelling, mobile, onClose, onCancel, onView }: {
  menu: PaperTaskMenuState | null;
  paper: WorkbenchPaper | undefined;
  runs: WorkbenchRun[];
  cancelling: ReadonlySet<string>;
  mobile: boolean;
  onClose(): void;
  onCancel(id: string): void;
  onView(): void;
}) {
  const { t, locale } = useI18n();
  const active = cancellablePaperRuns(menu?.paperId ?? "", runs);
  const items: SidebarMenuItem[] = [
    { type: "header", id: "paper", label: paper?.title ?? t("t1.taskActions") },
    { type: "item", id: "history", label: t("t1.viewTaskHistory"), icon: <MessageIcon size={14} />, onSelect: onView },
    { type: "separator", id: "tasks" },
    ...active.map((run): SidebarMenuItem => {
      const busy = cancelling.has(run.run_id);
      const created = run.created_at ? new Date(run.created_at).toLocaleString(locale, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : t("t1.timeUnrecorded");
      return { type: "custom", id: run.run_id, content: <button
        type="button" role="menuitem" tabIndex={-1} data-sidebar-menu-item="" data-cancel-run-id={run.run_id}
        className="sidebar-menu-item t1-task-action" aria-disabled={busy || undefined} aria-busy={busy}
        title={[created, run.model_id, run.run_id].filter(Boolean).join(" · ")}
        onClick={() => { if (!busy) { onCancel(run.run_id); onClose(); } }}
      >
        <CloseIcon size={14} />
        <span className="t1-task-action-copy"><strong>{t(busy ? "t1.cancelling" : "t1.cancel")} · {t(`t1.${run.state}`)}</strong><time dateTime={run.created_at}>{created}</time><small>{[run.model_id, `#${run.run_id.slice(-8)}`].filter(Boolean).join(" · ")}</small></span>
      </button> };
    }),
    ...(!active.length ? [{ type: "custom" as const, id: "empty", content: <p className="t1-task-menu-empty">{t("t1.noCancellableTasks")}</p> }] : []),
  ];
  return <SidebarMenu open={menu !== null} anchor={menu?.anchor ?? null} returnFocusTo={menu?.opener} sheet={mobile}
    ariaLabel={t("t1.taskActions")} title={t("t1.taskActions")} cancelLabel={t("t1.close")} width={352} items={items} onClose={onClose} />;
}
