"use client";
import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ArchiveIcon, CheckIcon, ChevronIcon, RestoreIcon } from "@/components/SidebarIcons";
import type { WorkbenchRecord, WorkbenchRetentionInput } from "../../../packages/contracts/src/workbench";
import { api, jsonBody, WorkbenchError } from "./api";

/** Everyday curation is independent of the legacy medical/source approval record. */
export function RecordRetention({ runId, record, onSaved, onNext }: { runId: string; record: WorkbenchRecord; onSaved: (changed?: boolean) => Promise<void>; onNext?: () => void }) {
  const { t } = useI18n(), excluded = record.retention?.status === "excluded";
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [conflict, setConflict] = useState(false);
  async function save() {
    setBusy(true); setError("");
    try {
      const input: WorkbenchRetentionInput = { expected_version: record.version, expected_retention_revision: record.retention?.revision ?? 0, status: excluded ? "kept" : "excluded" };
      await api(`workbench/runs/${encodeURIComponent(runId)}/records/${encodeURIComponent(record.id)}/retention`, jsonBody("POST", input));
      await onSaved(true);
    } catch (cause) {
      const changed = cause instanceof WorkbenchError && cause.status === 409;
      setConflict(changed); setError(changed ? t("t1.retentionConflict") : cause instanceof Error ? cause.message : t("t1.requestFailed"));
    } finally { setBusy(false); }
  }
  return <section className="t1-retention" aria-label={t("t1.retentionTitle")}>
    <span className="t1-retention-state">{excluded ? <ArchiveIcon size={14} /> : <CheckIcon size={14} />}{t(excluded ? "t1.excluded" : record.retention?.origin === "default" ? "t1.defaultKept" : "t1.kept")}</span>
    <div className="t1-retention-actions"><button className={`t1-button ${excluded ? "t1-primary" : "t1-exclude"}`} data-retention-action disabled={busy || conflict} onClick={() => void save()}>{excluded ? <RestoreIcon size={15} /> : <ArchiveIcon size={15} />}{t(busy ? "t1.saving" : excluded ? "t1.restoreKept" : "t1.excludeRecord")}</button>
      <button className="t1-button t1-next" disabled={busy || !onNext} onClick={onNext}>{t("t1.nextShort")}<ChevronIcon size={14} /></button></div>
    {error && <div className="t1-alert" role="alert">{error}{conflict && <button onClick={() => void onSaved()}>{t("t1.loadCurrent")}</button>}</div>}
  </section>;
}
