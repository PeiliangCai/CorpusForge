"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { api, jsonBody, WorkbenchError } from "./api";
import { ScopeConfiguration, ScopeSummary } from "./ScopeEditor";
import { scopeProblems, type ScopeCatalog } from "./scope";
import { runPresentation } from "./run-presentation";
import { preparePdfSelection, SelectionLimitError, MAX_PDF_FILES as MAX_FILES } from "./upload-selection";
import type { Scope } from "../../../packages/contracts/src/index";
import type { WorkbenchPaper, WorkbenchRun, WorkbenchSubmission, WorkbenchModelProfile, WorkbenchUpload } from "../../../packages/contracts/src/workbench";

type Status = "pending" | "invalid" | "uploading" | "uploadFailed" | "uploadRemoved" | "uploaded" | "starting" | "startFailed" | "submitted";
type Member = { id: string; file: File; displayName: string; sha256?: string; reused?: boolean; status: Status; error?: string; paper?: WorkbenchPaper; run?: WorkbenchRun; uploadKey: string; startKey: string };
export type StoragePaperAvailability = { removedPaperIds: readonly string[]; presentPaperIds?: readonly string[] };
type Props = { scope: Scope | null; catalog: ScopeCatalog | null; canUpload: boolean; canStart: boolean; runs: WorkbenchRun[];
  modelProfile: WorkbenchModelProfile | null; modelRequired: boolean;
  modelSelection?: ReactNode; storagePaperAvailability?: StoragePaperAvailability | null;
  onScopeChange: (scope: Scope) => void;
  onUploaded: (paper: WorkbenchPaper) => void; onStarted: (run: WorkbenchRun) => void; onSingleStarted: (run: WorkbenchRun) => void;
  onBatchStarted?: (runs: WorkbenchRun[], batchId: string) => void;
  onView: (run: WorkbenchRun) => void; errorText: (cause: unknown) => string };

/** One small in-memory selection. Uploads and admissions are sequential; the
 * existing server queue owns execution. Committed members never re-enter either loop. */
export function BatchSubmission({ scope, catalog, onScopeChange, canUpload, canStart, runs, modelProfile, modelRequired, modelSelection, storagePaperAvailability, onUploaded, onStarted, onSingleStarted, onBatchStarted, onView, errorText }: Props) {
  const { t } = useI18n();
  const [members, setMembers] = useState<Member[]>([]), [phase, setPhase] = useState<"choose" | "upload" | "start" | null>(null), [notice, setNotice] = useState(""), [taskTitle, setTaskTitle] = useState("");
  const busy = phase !== null;
  const [admission, setAdmission] = useState<{ scope: Scope; catalog: ScopeCatalog; submission: WorkbenchSubmission; model: WorkbenchModelProfile | null; taskTitle: string } | null>(null);
  const busyRef = useRef(false), membersRef = useRef<Member[]>([]), inputRef = useRef<HTMLInputElement>(null), folderRef = useRef<HTMLInputElement>(null);
  const lastStorageAvailability = useRef<StoragePaperAvailability | null>(null);
  const savedScope = admission?.scope;
  const replaceMembers = (next: Member[]) => { membersRef.current = next; setMembers(next); };
  const patch = (id: string, change: Partial<Member>) => replaceMembers(membersRef.current.map(member => member.id === id ? { ...member, ...change } : member));
  const uploaded = members.filter(member => member.paper).length, submitted = members.filter(member => member.run).length;
  const startable = members.filter(member => member.paper && !member.run);
  const batchScope = savedScope ?? scope;
  const batchCatalog = admission?.catalog ?? catalog;
  const invalidScope = !batchScope || !batchCatalog || scopeProblems(batchScope, batchCatalog).length > 0;
  const invalidModel = modelRequired && !(admission ? admission.model : modelProfile);
  const invalidTitle = taskTitle.length > 500 || /[\x00-\x1f]/.test(taskTitle);
  const validMembers = members.filter(member => member.status !== "invalid");
  const taskKind = admission?.submission.kind ?? (validMembers.length > 1 ? "batch" : "single");

  useEffect(() => {
    if (!storagePaperAvailability || lastStorageAvailability.current === storagePaperAvailability) return;
    lastStorageAvailability.current = storagePaperAvailability;
    const removed = new Set(storagePaperAvailability.removedPaperIds), present = storagePaperAvailability.presentPaperIds ? new Set(storagePaperAvailability.presentPaperIds) : null;
    let changed = false;
    const next = membersRef.current.map(member => {
      if (!member.paper || member.run || !removed.has(member.paper.id) && (!present || present.has(member.paper.id))) return member;
      changed = true;
      return { ...member, paper: undefined, reused: false, status: "uploadRemoved" as const, error: t("t1.storageDraftRemoved"), uploadKey: crypto.randomUUID(), startKey: crypto.randomUUID() };
    });
    if (changed) { membersRef.current = next; setMembers(next); }
  }, [storagePaperAvailability, t]);

  async function choose(files: FileList | null, folder = false) {
    if (!files || busyRef.current || savedScope || !canUpload) return;
    const selected = [...membersRef.current], incoming = Array.from(files).filter(file => !folder || /\.pdf$/i.test(file.name));
    const resetInputs = () => { if (inputRef.current) inputRef.current.value = ""; if (folderRef.current) folderRef.current.value = ""; };
    if (folder && !incoming.length) { setNotice(t("t1.folderNoPdf")); resetInputs(); return; }
    busyRef.current = true; setPhase("choose"); setNotice("");
    try {
      const prepared = await preparePdfSelection(incoming, new Set(selected.flatMap(member => member.sha256 ? [member.sha256] : [])), MAX_FILES - selected.length);
      const added: Member[] = [];
      let sameName = 0;
      for (const { file, sha256, invalid } of prepared.selected) {
        if (selected.some(member => member.file.name === file.name)) sameName++;
        const displayName = folder ? file.webkitRelativePath || file.name : file.name;
        const member: Member = { id: crypto.randomUUID(), file, displayName, sha256, status: invalid ? "invalid" : "pending", ...(invalid ? { error: t("t1.invalidPdf") } : {}), uploadKey: crypto.randomUUID(), startKey: crypto.randomUUID() };
        selected.push(member); added.push(member);
      }
      replaceMembers(selected); setNotice([folder ? t("t1.folderSelected", { count: incoming.length, skipped: files.length - incoming.length }) : "", prepared.duplicates ? t("t1.duplicatePdfsSkipped", { count: prepared.duplicates }) : "", sameName ? t("t1.batchSameName", { count: sameName }) : ""].filter(Boolean).join(" "));
      // Selection owns the lock through upload. Calling the guarded retry
      // handler here would silently skip these freshly selected members.
      if (added.some(member => member.status === "pending")) {
        setPhase("upload"); await uploadMembers(added);
      }
    } catch (cause) { setNotice(cause instanceof SelectionLimitError ? t("t1.batchLimitReached", { count: cause.count, remaining: cause.remaining }) : t("t1.pdfReadFailed")); }
    finally { busyRef.current = false; setPhase(null); resetInputs(); }
  }
  function chooseFolder() {
    if (!folderRef.current || !("webkitdirectory" in folderRef.current)) { setNotice(t("t1.folderUnsupported")); return; }
    folderRef.current.click();
  }
  async function uploadMembers(selected: Member[]) {
    for (const selectedMember of selected) {
      const member = membersRef.current.find(member => member.id === selectedMember.id);
      if (!member || member.paper || member.run || !["pending", "uploadFailed", "uploadRemoved"].includes(member.status)) continue;
      patch(member.id, { status: "uploading", error: undefined });
      try {
        const value = await api<WorkbenchUpload>("workbench/papers", { method: "POST", headers: { "content-type": "application/pdf", "x-t1-filename": encodeURIComponent(member.file.name), "x-t1-request-id": member.uploadKey }, body: member.file });
        patch(member.id, { paper: value.paper, reused: value.reused, status: "uploaded", error: undefined }); onUploaded(value.paper);
      } catch (cause) { patch(member.id, { status: "uploadFailed", error: errorText(cause) }); }
    }
  }
  async function upload(selected: Member[]) {
    if (busyRef.current || !canUpload) return;
    busyRef.current = true; setPhase("upload"); setNotice("");
    try { await uploadMembers(selected); }
    finally { busyRef.current = false; setPhase(null); }
  }
  async function start(selected = startable) {
    if (busyRef.current || !canStart || invalidScope || invalidModel || invalidTitle || !batchScope || !batchCatalog) return;
    busyRef.current = true; setPhase("start"); setNotice("");
    // Count every valid selected member, including failed uploads that may retry later.
    // Scope and submission identity freeze together before the first start request.
    const saved = admission ?? { scope: structuredClone(batchScope), catalog: structuredClone(batchCatalog), submission: taskKind === "batch" ? { kind: "batch", batch_id: crypto.randomUUID() } as const : { kind: "single" } as const, model: modelProfile ? structuredClone(modelProfile) : null, taskTitle: taskTitle.trim() };
    setAdmission(saved);
    try {
      for (const member of selected) {
        if (!member.paper || member.run) continue;
        patch(member.id, { status: "starting", error: undefined });
        try {
          const value = await api<{ run: WorkbenchRun }>(`workbench/papers/${encodeURIComponent(member.paper.id)}/runs`, {
            ...jsonBody("POST", { scope: saved.scope, submission: saved.submission, ...(saved.model ? { model_profile_id: saved.model.profile_id } : {}), ...(saved.taskTitle ? { task_title: saved.taskTitle } : {}), original_filename: member.file.name }), headers: { "content-type": "application/json", "x-t1-request-id": member.startKey } });
          if (typeof value.run?.run_id !== "string" || !value.run.run_id.trim() || value.run.document_id !== member.paper.id) throw new Error(t("t1.taskCreationUnconfirmed"));
          if (value.run.scope_catalog) setAdmission(current => current ? { ...current, catalog: { ...current.catalog, catalog: value.run.scope_catalog! } } : current);
          patch(member.id, { run: value.run, status: "submitted", error: undefined }); onStarted(value.run);
          if (saved.submission.kind === "single") onSingleStarted(value.run);
        } catch (cause) {
          patch(member.id, { status: "startFailed", error: errorText(cause) });
          // A definite version rejection admitted nothing. Let refresh repair the draft; an unknown/lost response keeps its identity.
          if (cause instanceof WorkbenchError && cause.code.split(",").includes("catalog_version_mismatch")) { setAdmission(null); break; }
        }
      }
      const valid = membersRef.current.filter(member => member.status !== "invalid");
      if (saved.submission.kind === "batch" && valid.length > 0 && valid.every(member => member.run)) onBatchStarted?.(valid.map(member => member.run!), saved.submission.batch_id);
    } finally { busyRef.current = false; setPhase(null); }
  }

  return <section className="t1-upload t1-batch" aria-label={t("t1.batchTitle")} aria-busy={busy}>
    <div className="t1-draft-layout">
      <section className="t1-task-card t1-files-card" aria-label={t("t1.uploadTitle")}>
        <h2 className="t1-task-card-title">{t("t1.uploadTitle")}<span className="t1-badge">PDF</span></h2>
        <div className="t1-files-body">
          <div className="t1-file-picker">
            <p className="t1-lead">{t("t1.batchHelp")}</p>
            <div className="t1-file-choices">
              <button className="t1-primary" disabled={busy || !canUpload || Boolean(savedScope) || members.length >= MAX_FILES} onClick={() => inputRef.current?.click()}>{t(phase === "choose" ? "t1.checkingPdfs" : "t1.chooseFiles")}</button>
              <button className="t1-button" disabled={busy || !canUpload || Boolean(savedScope) || members.length >= MAX_FILES} onClick={chooseFolder}>{t("t1.chooseFolder")}</button>
              <input hidden aria-label={t("t1.choosePdf")} type="file" accept="application/pdf,.pdf" multiple ref={inputRef} disabled={busy || !canUpload || Boolean(savedScope)} onChange={event => void choose(event.target.files)} />
              <input hidden aria-label={t("t1.chooseFolder")} type="file" multiple {...{ webkitdirectory: "" }} ref={folderRef} disabled={busy || !canUpload || Boolean(savedScope)} onChange={event => void choose(event.target.files, true)} />
            </div><p className="t1-footnote">{t("t1.folderHelp")}</p>
          </div>
          {notice && <p className="t1-notice" role="status">{notice}</p>}
          <label className="t1-field t1-task-title-field">{t("t1.paperTitle")}<input aria-label={t("t1.paperTitle")} value={taskTitle} disabled={busy || Boolean(admission)} maxLength={500} onChange={event => setTaskTitle(event.target.value)} /></label>
          <p className="t1-footnote">{t(taskKind === "batch" ? "t1.batchTaskTitleHelp" : "t1.singleTaskTitleHelp")}</p>
          {invalidTitle && <p className="t1-batch-error" role="alert">{t("t1.invalidTaskTitle")}</p>}
          <p className="t1-batch-counts" role="status">{t("t1.batchCounts", { total: members.length, uploaded, submitted })}</p>
          <div className="t1-file-list" role="region" aria-label={t("t1.selectedPapers")} tabIndex={0}>
            {members.length ? <ul className="t1-batch-members">{members.map(member => {
        const run = runs.find(run => run.run_id === member.run?.run_id) ?? member.run;
        return <li key={member.id} data-batch-member={member.id} data-upload-state={member.status}>
          <div className="t1-batch-file"><strong title={member.displayName}>{member.displayName}</strong><small>{(member.file.size / 1024 / 1024).toFixed(1)} MiB</small></div>
          <div className="t1-batch-member-actions"><span className="t1-batch-state" role="status">{t(`t1.batch_${member.status}`)}{run && ` · ${t(`t1.${runPresentation(run.state, run).statusKey}`)}`}</span>
            {(member.status === "uploadFailed" || member.status === "uploadRemoved") && <button className="t1-button" disabled={busy} onClick={() => void upload([member])}>{t(member.status === "uploadRemoved" ? "t1.storageReupload" : "t1.retryUpload")}</button>}
            {member.status === "startFailed" && <button className="t1-button" disabled={busy || !canStart || invalidScope || invalidModel || invalidTitle} onClick={() => void start([member])}>{t("t1.retryStart")}</button>}
            {run ? <button className="t1-button" onClick={() => onView(run)}>{t("t1.viewTask")}</button> : <button className="t1-button" disabled={busy} onClick={() => replaceMembers(membersRef.current.filter(item => item.id !== member.id))}>{t("t1.removeFile")}</button>}
          </div>{member.error && <p className="t1-batch-error" role="alert">{member.error}{member.status !== "invalid" && ` ${t("t1.batchRetrySafe")}`}</p>}
          {member.reused && <p className="t1-footnote">{t("t1.reusedPdf")}</p>}
        </li>;
            })}</ul> : <p className="t1-file-list-empty">{t("t1.noSelectedPapers")}</p>}
          </div>
        </div>
      </section>
      <div className="t1-task-settings">
        {scope && catalog && <div className="t1-task-card t1-scope-card"><h2 className="t1-task-card-title">{t("t1.scopeTitle")}</h2><ScopeConfiguration scope={scope} data={catalog} onChange={onScopeChange} /></div>}
        {modelSelection}
      </div>
    </div>
    <div className="t1-draft-footer">
      <div className="t1-batch-actions">
        <button className="t1-primary" disabled={busy || !startable.length || !canStart || invalidScope || invalidModel || invalidTitle} onClick={() => void start()}>{t(phase === "start" ? "t1.starting" : taskKind === "single" ? "t1.startSingle" : "t1.startBatch", { count: startable.length })}</button>
        <button className="t1-button" disabled={busy || !members.length} onClick={() => { replaceMembers([]); setAdmission(null); setNotice(""); setTaskTitle(""); }}>{t("t1.clearBatch")}</button></div>
      <p className="t1-footnote t1-clear-help">{t("t1.clearSelectionHelp")}</p>
      {admission && <p className="t1-footnote" data-saved-task-title>{t("t1.savedTaskTitle")}: {admission.taskTitle || t(taskKind === "batch" ? "t1.taskBatch" : "t1.originalFilenameDefault")}</p>}
      {savedScope && <div className="t1-batch-scope"><strong>{t("t1.batchSavedScope")}</strong><ScopeSummary scope={savedScope} snapshot={admission?.catalog.catalog} />{admission?.model && <p data-batch-model={admission.model.profile_id}>{t("t1.savedBatchModel")}: {admission.model.model_id}</p>}<p className="t1-footnote">{t("t1.batchScopeHelp")}</p></div>}
      <p className="t1-footnote">{t("t1.batchIndependent")}</p>
    </div>
  </section>;
}
