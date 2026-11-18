"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CloseIcon, RefreshIcon } from "@/components/SidebarIcons";
import { useI18n } from "@/hooks/useI18n";
import { cleanupStorage, previewStorage, WorkbenchError } from "./api";
import { GlobalToasts, type GlobalToastNotice } from "./GlobalToasts";
import type { WorkbenchStorageCandidate, WorkbenchStorageCleanupResult, WorkbenchStoragePreview, WorkbenchStorageSummary } from "../../../packages/contracts/src/workbench";

const errorKeys: Record<string, string> = {
  storage_preview_stale: "storagePreviewStale", storage_preview_expired: "storagePreviewExpired",
  storage_busy: "storageBusy", storage_selection_conflict: "storageSelectionConflict",
  invalid_storage_selection: "storageInvalidSelection", invalid_storage_request: "storageInvalidSelection",
  storage_scope_unavailable: "storageScopeUnavailable", storage_reference_unavailable: "storageReferenceUnavailable",
  storage_file_changed: "storageFileChanged", storage_file_unavailable: "storageFileUnavailable",
  storage_reference_changed: "storageReferenceChanged", storage_remove_failed: "storageRemoveFailed",
};
const kindKeys: Record<WorkbenchStorageCandidate["kind"], string> = {
  unused_upload: "storageUnusedUpload", orphan_pdf: "storageOrphanPdf", orphan_parse: "storageOrphanParse",
  orphan_figures: "storageOrphanFigures", orphan_export: "storageOrphanExport",
};
const protectionKeys: Record<string, string> = {
  referenced: "storageReferenced", recent_upload: "storageRecentUpload", active_work: "storageActiveWork",
  immutable_source: "storageImmutableSource", unsafe_link: "storageUnsafeLink", unknown: "storageUnknownOwnership",
};
const categoryKeys: Record<string, string> = { pdf: "storagePdf", parse: "storageParse", figures: "storageFigures", exports: "storageExports", other: "storageOther" };

/** Logical sizes of managed files; these never promise recovered filesystem space. */
export function storageBytes(bytes: number, locale: string): string {
  if (bytes < 1024) return `${new Intl.NumberFormat(locale).format(bytes)} B`;
  const exponent = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024 ** exponent)} ${["B", "KiB", "MiB", "GiB", "TiB"][exponent]}`;
}

export function StorageIcon({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" /></svg>;
}

type Failure = { id: string; name: string; reason: string };
type Props = { open: boolean; onClose(): void; onCleaned(removedPaperIds: string[]): Promise<void> | void };

/** A fresh server preview is the sole source of cleanup eligibility. */
export function StorageManagement({ open, onClose, onCleaned }: Props) {
  const { t, locale } = useI18n();
  const panel = useRef<HTMLDialogElement>(null), opener = useRef<HTMLElement | null>(null);
  const [preview, setPreview] = useState<WorkbenchStoragePreview | null>(null), [summary, setSummary] = useState<WorkbenchStorageSummary | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set()), [reviewing, setReviewing] = useState(false);
  const [loading, setLoading] = useState(false), [cleaning, setCleaning] = useState(false), [problem, setProblem] = useState("");
  const [failures, setFailures] = useState<Failure[]>([]), [notice, setNotice] = useState<GlobalToastNotice | null>(null);
  const read = useRef<AbortController | null>(null), sequence = useRef(0), executing = useRef(false);
  const paperRecheckNeeded = useRef(false);
  const callbacks = useRef({ t, locale, onCleaned }); callbacks.current = { t, locale, onCleaned };
  const errorText = useCallback((cause: unknown, fallback = "storageReadFailed") => {
    const code = cause instanceof WorkbenchError ? cause.code : "";
    return callbacks.current.t(`t1.${errorKeys[code] ?? fallback}`);
  }, []);

  const loadPreview = useCallback(async (clearProblem = true, recheckPapers = true) => {
    const version = ++sequence.current;
    read.current?.abort(); const controller = new AbortController(); read.current = controller;
    setLoading(true); setPreview(null); setSelected(new Set()); setReviewing(false);
    if (clearProblem) { setProblem(""); setFailures([]); }
    try {
      const value = await previewStorage(controller.signal);
      if (controller.signal.aborted || version !== sequence.current) return;
      setPreview(value); setSummary(value.summary);
      if (recheckPapers && paperRecheckNeeded.current) {
        try { await callbacks.current.onCleaned([]); paperRecheckNeeded.current = false; }
        catch { if (!controller.signal.aborted && version === sequence.current) setProblem(current => [current, callbacks.current.t("t1.storageWorkspaceRefreshFailed")].filter(Boolean).join(" ")); }
      }
    } catch (cause) {
      if (controller.signal.aborted || version !== sequence.current) return;
      const message = errorText(cause);
      setProblem(current => clearProblem || !current ? message : `${current} ${message}`);
      setNotice({ text: message, failed: true });
    } finally { if (version === sequence.current) setLoading(false); }
  }, [errorText]);

  const cancelRead = useCallback(() => { ++sequence.current; read.current?.abort(); }, []);

  useEffect(() => {
    const dialog = panel.current;
    if (!open) { if (dialog?.open) dialog.close(); return; }
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    setSummary(null); void loadPreview();
    return cancelRead;
  }, [open, loadPreview, cancelRead]);

  const candidates = preview?.candidates ?? [];
  const chosen = candidates.filter(item => selected.has(item.id));
  const chosenBytes = chosen.reduce((sum, item) => sum + item.bytes, 0);
  const busy = loading || cleaning;
  const canReview = Boolean(preview?.summary.cleanup_available && chosen.length && !busy);
  const bytes = (value: number) => storageBytes(value, locale);
  const parts = (item: WorkbenchStorageCandidate) => item.parts.filter(part => part.files > 0).map(part => `${t(`t1.${categoryKeys[part.kind] ?? "storageOther"}`)} ${bytes(part.bytes)}`).join(" · ");

  function close() { if (!executing.current) panel.current?.close(); }

  async function execute() {
    if (executing.current || !preview || !canReview || !reviewing) return;
    executing.current = true; setCleaning(true); setProblem(""); setFailures([]);
    const submitted = chosen;
    try {
      const result: WorkbenchStorageCleanupResult = await cleanupStorage({ preview_id: preview.preview_id, version: preview.version, candidate_ids: submitted.map(item => item.id) });
      setSummary(result.summary); setSelected(new Set()); setReviewing(false);
      const unfinished = result.results.filter(item => item.status === "failed" || item.status === "protected");
      const partial = result.status === "partial";
      const message = callbacks.current.t(`t1.${partial ? "storagePartial" : "storageCleaned"}`, { count: result.removed_files, size: storageBytes(result.removed_bytes, callbacks.current.locale) });
      setNotice({ text: message, failed: partial });
      setProblem(partial ? callbacks.current.t("t1.storagePartialHelp") : "");
      setFailures(unfinished.map(item => ({ id: item.id, name: submitted.find(candidate => candidate.id === item.id)?.name ?? callbacks.current.t("t1.storageItem"), reason: callbacks.current.t(`t1.${errorKeys[item.error ?? ""] ?? (item.status === "protected" ? "storageReferenceChanged" : "storageRemoveFailed")}`) })));
      paperRecheckNeeded.current = true;
      try { await callbacks.current.onCleaned(result.removed_paper_ids); paperRecheckNeeded.current = false; }
      catch { setProblem(current => [current, callbacks.current.t("t1.storageWorkspaceRefreshFailed")].filter(Boolean).join(" ")); }
      await loadPreview(false, false);
    } catch (cause) {
      const message = errorText(cause, "storageCleanupUnconfirmed");
      setProblem(message); setNotice({ text: message, failed: true });
      // A failed response may follow a successful deletion. Never silently reuse
      // the old selection, or widen it to a freshly generated candidate list.
      paperRecheckNeeded.current = true;
      try { await callbacks.current.onCleaned([]); paperRecheckNeeded.current = false; }
      catch { setProblem(current => [current, callbacks.current.t("t1.storageWorkspaceRefreshFailed")].filter(Boolean).join(" ")); }
      await loadPreview(false, false);
    } finally { executing.current = false; setCleaning(false); }
  }

  const toastTarget = open ? panel.current : typeof document === "undefined" ? null : document.body;
  return <>
    <dialog ref={panel} className="t1-storage-dialog" aria-labelledby="t1-storage-title" aria-describedby="t1-storage-scope" onCancel={event => { event.preventDefault(); close(); }} onClose={() => { if (!executing.current) { onClose(); opener.current?.focus(); } }}>
      <header className="t1-storage-header"><div><h2 id="t1-storage-title">{t(reviewing ? "t1.storageConfirmTitle" : "t1.storageManagement")}</h2><p id="t1-storage-scope">{t("t1.storageScope")}</p></div><button type="button" autoFocus className="t1-icon-button" disabled={cleaning} aria-label={t("t1.close")} onClick={close}><CloseIcon size={17} /></button></header>
      <div className="t1-storage-scroll" aria-busy={busy}>
        {problem && <div className="t1-storage-problem" role="alert"><p>{problem}</p>{failures.length > 0 && <ul>{failures.map(item => <li key={item.id}><strong>{item.name}</strong> · {item.reason}</li>)}</ul>}</div>}
        {reviewing ? <>
          <p className="t1-storage-warning" id="t1-storage-confirm-warning">{t("t1.storageIrreversible")}</p>
          <p className="t1-storage-selected-summary">{t("t1.storageSelected", { count: chosen.length, size: bytes(chosenBytes) })}</p>
          <ul className="t1-storage-candidates t1-storage-confirm-list">{chosen.map(item => <li key={item.id} data-storage-confirm-id={item.id}><div className="t1-storage-file"><strong>{item.name}</strong><span>{t(`t1.${kindKeys[item.kind]}`)}</span><small>{parts(item)}</small></div><span className="t1-storage-size">{bytes(item.bytes)}</span></li>)}</ul>
        </> : <>
          <dl className="t1-storage-stats">{[["storageTotal", summary?.total_bytes], ["storageProtected", summary?.protected_bytes], ["storageReclaimable", summary?.reclaimable_bytes]].map(([label, size]) => <div key={label}><dt>{t(`t1.${label}`)}</dt><dd data-storage-stat={label}>{typeof size === "number" ? bytes(size) : "—"}</dd></div>)}</dl>
          {summary && <>
            <dl className="t1-storage-categories">{summary.categories.filter(item => item.bytes > 0).map(item => <div key={item.kind}><dt>{t(`t1.${categoryKeys[item.kind] ?? "storageOther"}`)}</dt><dd>{bytes(item.bytes)}</dd></div>)}</dl>
            <details className="t1-storage-protection"><summary>{t("t1.storageProtectionTitle")}</summary><p>{t("t1.storageProtectionHelp", { hours: summary.policy.recent_upload_protection_hours })}</p>{summary.protected_reasons.length > 0 && <ul>{summary.protected_reasons.map(item => <li key={item.code}><span>{t(`t1.${protectionKeys[item.code] ?? "storageUnknownOwnership"}`, { hours: summary.policy.recent_upload_protection_hours })}</span><span>{bytes(item.bytes)}</span></li>)}</ul>}</details>
            {summary.unknown_bytes > 0 && <p className="t1-storage-help">{t("t1.storageUnknownHelp", { size: bytes(summary.unknown_bytes) })}</p>}
            {!summary.cleanup_available && <p className="t1-storage-warning" role="status">{t(`t1.${errorKeys[summary.unavailable_reason ?? ""] ?? "storageScopeUnavailable"}`)}</p>}
          </>}
          <div className="t1-storage-list-heading"><h3>{t("t1.storageCandidates")}</h3><span>{candidates.length}</span><button type="button" className="t1-button" disabled={busy} aria-busy={loading} onClick={() => void loadPreview()}><RefreshIcon size={13} />{t(loading ? "t1.storagePreviewLoading" : "t1.storageRefreshPreview")}</button></div>
          {loading ? <p className="t1-storage-empty" role="status">{t("t1.storagePreviewLoading")}</p> : !preview ? <p className="t1-storage-empty">{t("t1.storageNoPreview")}</p> : candidates.length === 0 ? <p className="t1-storage-empty" role="status">{t("t1.storageNothingToClean")}</p> : <>
            <p className="t1-storage-help">{t("t1.storageSelectionHelp")}</p>
            <ul className="t1-storage-candidates">{candidates.map(item => <li key={item.id} data-storage-candidate-id={item.id}><label><input type="checkbox" checked={selected.has(item.id)} disabled={busy || !summary?.cleanup_available} onChange={event => { const checked = event.currentTarget.checked; setSelected(current => { const next = new Set(current); if (checked) next.add(item.id); else next.delete(item.id); return next; }); }} /><div className="t1-storage-file"><strong>{item.name}</strong><span>{t(`t1.${kindKeys[item.kind]}`)}</span><small>{parts(item)}</small></div><span className="t1-storage-size">{bytes(item.bytes)}</span></label></li>)}</ul>
          </>}
        </>}
      </div>
      <footer className="t1-storage-footer"><span role="status">{t("t1.storageSelected", { count: chosen.length, size: bytes(chosenBytes) })}</span><div>{reviewing ? <><button type="button" className="t1-button" disabled={cleaning} onClick={() => setReviewing(false)}>{t("t1.storageBackToSelection")}</button><button type="button" className="t1-primary" aria-describedby="t1-storage-confirm-warning" disabled={!canReview} aria-busy={cleaning} onClick={() => void execute()}>{t(cleaning ? "t1.storageCleaning" : "t1.storageConfirmCleanup")}</button></> : <><button type="button" className="t1-button" disabled={cleaning} onClick={close}>{t("t1.close")}</button><button type="button" className="t1-primary" disabled={!canReview} onClick={() => setReviewing(true)}>{t("t1.storageReviewSelection")}</button></>}</div></footer>
      {cleaning && <span className="t1-sr-only" role="status">{t("t1.storageCleaning")}</span>}
    </dialog>
    {notice && toastTarget && createPortal(<GlobalToasts dismissLabel={t("t1.close")} items={[{ id: "storage", notice, className: "t1-storage-toast", onDismiss: () => setNotice(null) }]} />, toastTarget)}
  </>;
}
