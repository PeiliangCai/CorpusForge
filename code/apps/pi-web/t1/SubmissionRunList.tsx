"use client";

import type { MouseEvent } from "react";
import { MoreIcon } from "@/components/SidebarIcons";
import { useI18n } from "@/hooks/useI18n";
import type { WorkbenchPaper, WorkbenchRun } from "../../../packages/contracts/src/workbench";
import { TaskKindBadge } from "./TaskKindBadge";
import { groupSubmittedRuns, submissionRun } from "./submission-groups";
import { originalRunFilename, taskDisplayTitle } from "./task-titles";

export function SubmissionRunList({ runs, papers, selectedId, variant, menuRunId, query = "", onSelect, onMenu, statusLabel }: {
  runs: WorkbenchRun[]; papers: WorkbenchPaper[]; selectedId: string | null; variant: "sidebar" | "history"; menuRunId?: string;
  query?: string; onSelect(run: WorkbenchRun): void;
  onMenu(event: MouseEvent<HTMLButtonElement>, run: WorkbenchRun): void; statusLabel(run: WorkbenchRun): string;
}) {
  const { t, locale } = useI18n(), needle = query.trim().toLocaleLowerCase();
  const groups = groupSubmittedRuns(runs).filter(group => !needle || group.runs.some(run => {
    const paper = papers.find(item => item.id === run.document_id);
    return [run.task_title, run.original_filename, paper?.filename, paper?.title, run.run_id].filter(Boolean).join(" ").toLocaleLowerCase().includes(needle);
  }));
  const time = (value?: string) => value ? new Date(value).toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : t("t1.timeUnrecorded");
  return <div className={`t1-submission-list t1-submission-${variant}`} data-submission-list={variant}>
    {!groups.length && <p className="t1-submission-empty">{t(needle ? "t1.noMatchingTasks" : "t1.noSubmittedTasks")}</p>}
    {groups.map(group => {
      const run = group.runs[0]!, summary = submissionRun(group), paper = papers.find(paper => paper.id === run.document_id);
      const title = group.kind === "batch" ? group.taskTitle ?? t("t1.taskBatch") : taskDisplayTitle(run, paper);
      const selected = group.runs.some(run => run.run_id === selectedId), menuOpen = group.runs.some(run => run.run_id === menuRunId);
      const tooltip = [title, time(group.createdAt), ...group.runs.map(run => originalRunFilename(run, papers.find(paper => paper.id === run.document_id))), group.id].join(" · ");
      return <section key={group.id} data-submission-group={group.id} data-submission-kind={group.kind}>
        <div className={`t1-run-nav-row${selected ? " selected" : ""}`} data-task-id={group.id} data-run-row={run.run_id}>
          <button className="t1-run-select" data-run-id={run.run_id} data-paper-id={run.document_id} aria-current={selected ? "page" : undefined} title={tooltip} onClick={() => onSelect(run)}>
            <strong>{title}</strong><span className="t1-run-meta"><TaskKindBadge kind={group.kind === "unrecorded" ? undefined : group.kind} /><time dateTime={group.createdAt}>{time(group.createdAt)}</time><span>#{group.kind === "batch" ? group.id.slice(-8) : run.run_id.slice(-8)}</span></span>
            <span className="t1-run-model" title={run.model_id}>{run.model_id ?? t("t1.modelUnrecorded")}{group.kind === "batch" && ` · ${t("t1.batchPaperCount", { count: group.runs.length })}`}</span>
            <span className="t1-run-state"><i data-state={summary.state} />{statusLabel(summary)}<small>{t("t1.recordCount", { count: summary.candidate_count })}</small></span>
          </button>
          <button type="button" className="t1-paper-actions" data-run-menu-id={run.run_id} data-task-menu-id={group.id} aria-label={`${t("t1.taskActions")} · #${group.id.slice(-8)}`} title={t("t1.taskActions")} aria-haspopup="menu" aria-expanded={menuOpen} onClick={event => onMenu(event, run)}><MoreIcon size={17} /></button>
        </div>
      </section>;
    })}
  </div>;
}
