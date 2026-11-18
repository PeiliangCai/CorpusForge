"use client";

import { useEffect, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";

export interface RunDeleteTarget { readonly runId: string; readonly paperId: string; readonly title: string; readonly createdAt?: string; readonly modelId?: string; readonly opener?: HTMLButtonElement; readonly batchId?: string; readonly members?: readonly { runId: string; paperId: string; filename: string }[] }
export function RunDeleteDialog({ target, busy, blocked, cleanupPending, error, onClose, onConfirm }: {
  target: RunDeleteTarget | null; busy: boolean; blocked: boolean; cleanupPending: boolean; error: string; onClose(): void; onConfirm(target: RunDeleteTarget): void;
}) {
  const { t, locale } = useI18n(), panel = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = panel.current;
    if (target && !dialog?.open) dialog?.showModal();
    else if (!target && dialog?.open) dialog.close();
  }, [target]);
  return <dialog ref={panel} className="t1-delete-dialog" aria-labelledby="t1-delete-title" aria-describedby="t1-delete-scope" onCancel={event => { if (busy) event.preventDefault(); }} onClose={() => { if (!busy) { target?.opener?.focus(); onClose(); } }}>
    <h2 id="t1-delete-title">{t("t1.deleteRun")}</h2>
    {target && <div className="t1-delete-target" data-delete-run-id={target.runId}><strong>{target.title}</strong><time dateTime={target.createdAt}>{target.createdAt ? new Date(target.createdAt).toLocaleString(locale) : t("t1.timeUnrecorded")}</time><span>{target.modelId ?? t("t1.modelUnrecorded")}</span><code>{target.batchId ?? target.runId}</code></div>}
    {target?.batchId && <p className="t1-delete-warning" data-delete-batch={target.batchId}>{t("t1.deleteBatchCount", { count: target.members?.length ?? 0 })}</p>}
    {target?.batchId && <ul className="t1-delete-members">{target.members?.map(member => <li key={member.runId}>{member.filename}</li>)}</ul>}
    <p id="t1-delete-scope">{t(target?.batchId ? "t1.deleteBatchHelp" : "t1.deleteRunHelp")}</p><p className="t1-delete-warning">{t("t1.deleteRunIrreversible")}</p>
    {blocked && <p className="t1-delete-warning" role="status">{t("t1.runDeleteBusy")}</p>}
    {error && <p className="t1-delete-warning" role="alert">{error}</p>}
    <div className="t1-delete-actions"><button type="button" autoFocus className="t1-button" disabled={busy} onClick={() => { panel.current?.close(); }}>{t(cleanupPending ? "t1.close" : "t1.keepRun")}</button><button type="button" className="t1-primary" disabled={busy || blocked || !target} aria-busy={busy} onClick={() => { if (target) onConfirm(target); }}>{t(busy ? "t1.deletingRun" : cleanupPending ? "t1.retryCleanup" : "t1.confirmDeleteRun")}</button></div>
  </dialog>;
}
