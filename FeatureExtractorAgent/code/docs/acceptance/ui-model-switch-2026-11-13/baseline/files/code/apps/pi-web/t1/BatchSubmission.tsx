"use client";

import { useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { api, jsonBody } from "./api";
import { ScopeEditor, ScopeSummary } from "./ScopeEditor";
import { scopeProblems, type ScopeCatalog } from "./scope";
import { runPresentation } from "./run-presentation";
import { TaskKindBadge } from "./TaskKindBadge";
import type { Scope } from "../../../packages/contracts/src/index";
import type { WorkbenchPaper, WorkbenchRun, WorkbenchSubmission } from "../../../packages/contracts/src/workbench";

const MAX_FILES = 20, MAX_BYTES = 50 * 1024 * 1024;
type Status = "pending" | "invalid" | "uploading" | "uploadFailed" | "uploaded" | "starting" | "startFailed" | "submitted";
type Member = { id: string; file: File; displayName: string; title: string; status: Status; error?: string; paper?: WorkbenchPaper; run?: WorkbenchRun; uploadKey: string; startKey: string };
type Props = { scope: Scope | null; catalog: ScopeCatalog | null; canUpload: boolean; canStart: boolean; runs: WorkbenchRun[];
  onScopeChange: (scope: Scope) => void;
  onUploaded: (paper: WorkbenchPaper) => void; onStarted: (run: WorkbenchRun) => void; onView: (run: WorkbenchRun) => void; errorText: (cause: unknown) => string };

/** One small in-memory selection. Uploads and admissions are sequential; the
 * existing server queue owns execution. Committed members never re-enter either loop. */
export function BatchSubmission({ scope, catalog, onScopeChange, canUpload, canStart, runs, onUploaded, onStarted, onView, errorText }: Props) {
  const { t } = useI18n();
  const [members, setMembers] = useState<Member[]>([]), [phase, setPhase] = useState<"upload" | "start" | null>(null), [notice, setNotice] = useState("");
  const busy = phase !== null;
  const [admission, setAdmission] = useState<{ scope: Scope; submission: WorkbenchSubmission } | null>(null);
  const busyRef = useRef(false), inputRef = useRef<HTMLInputElement>(null), folderRef = useRef<HTMLInputElement>(null);
  const savedScope = admission?.scope;
  const patch = (id: string, change: Partial<Member>) => setMembers(current => current.map(member => member.id === id ? { ...member, ...change } : member));
  const uploaded = members.filter(member => member.paper).length, submitted = members.filter(member => member.run).length;
  const uploadable = members.filter(member => member.status === "pending" || member.status === "uploadFailed");
  const startable = members.filter(member => member.paper && !member.run);
  const batchScope = savedScope ?? scope;
  const invalidScope = !batchScope || !catalog || scopeProblems(batchScope, catalog).length > 0;
  const validMembers = members.filter(member => member.status !== "invalid");
  const taskKind = admission?.submission.kind ?? (validMembers.length > 1 ? "batch" : "single");

  function choose(files: FileList | null, folder = false) {
    if (!files || busyRef.current || savedScope) return;
    const selected = [...members], incoming = Array.from(files).filter(file => !folder || /\.pdf$/i.test(file.name));
    const resetInputs = () => { if (inputRef.current) inputRef.current.value = ""; if (folderRef.current) folderRef.current.value = ""; };
    if (folder && !incoming.length) { setNotice(t("t1.folderNoPdf")); resetInputs(); return; }
    if (incoming.length > MAX_FILES - selected.length) {
      setNotice(t("t1.batchLimitReached", { count: incoming.length, remaining: MAX_FILES - selected.length })); resetInputs(); return;
    }
    let sameName = 0;
    for (const file of incoming) {
      // Metadata cannot prove file identity (different folders can have identical
      // names, sizes and timestamps). Keep both and make the ambiguity visible.
      if (selected.some(member => member.file.name === file.name)) sameName++;
      const invalid = !/\.pdf$/i.test(file.name) || file.size === 0 || file.size > MAX_BYTES || file.name.length > 240;
      const displayName = folder ? file.webkitRelativePath || file.name : file.name;
      selected.push({ id: crypto.randomUUID(), file, displayName, title: folder ? displayName.replace(/[\x00-\x1f]/g, "").slice(-500) : "", status: invalid ? "invalid" : "pending", ...(invalid ? { error: t("t1.invalidPdf") } : {}), uploadKey: crypto.randomUUID(), startKey: crypto.randomUUID() });
    }
    setMembers(selected); setNotice([folder ? t("t1.folderSelected", { count: incoming.length, skipped: files.length - incoming.length }) : "", sameName ? t("t1.batchSameName", { count: sameName }) : ""].filter(Boolean).join(" ")); resetInputs();
  }
  function chooseFolder() {
    if (!folderRef.current || !("webkitdirectory" in folderRef.current)) { setNotice(t("t1.folderUnsupported")); return; }
    folderRef.current.click();
  }
  async function upload(selected = uploadable) {
    if (busyRef.current || !canUpload) return;
    busyRef.current = true; setPhase("upload"); setNotice("");
    try {
      for (const member of selected) {
        patch(member.id, { status: "uploading", error: undefined });
        try {
          const value = await api<{ paper: WorkbenchPaper }>("workbench/papers", { method: "POST", headers: { "content-type": "application/pdf", "x-t1-filename": encodeURIComponent(member.file.name), "x-t1-request-id": member.uploadKey,
            ...(member.title.trim() ? { "x-t1-title": encodeURIComponent(member.title.trim()) } : {}) }, body: member.file });
          patch(member.id, { paper: value.paper, status: "uploaded", error: undefined }); onUploaded(value.paper);
        } catch (cause) { patch(member.id, { status: "uploadFailed", error: errorText(cause) }); }
      }
    } finally { busyRef.current = false; setPhase(null); }
  }
  async function start(selected = startable) {
    if (busyRef.current || !canStart || invalidScope || !batchScope) return;
    busyRef.current = true; setPhase("start"); setNotice("");
    // Count every valid selected member, including failed uploads that may retry later.
    // Scope and submission identity freeze together before the first start request.
    const saved = admission ?? { scope: structuredClone(batchScope), submission: taskKind === "batch" ? { kind: "batch", batch_id: crypto.randomUUID() } as const : { kind: "single" } as const };
    setAdmission(saved);
    try {
      for (const member of selected) {
        if (!member.paper || member.run) continue;
        patch(member.id, { status: "starting", error: undefined });
        try {
          const value = await api<{ run: WorkbenchRun }>(`workbench/papers/${encodeURIComponent(member.paper.id)}/runs`, {
            ...jsonBody("POST", { scope: saved.scope, submission: saved.submission }), headers: { "content-type": "application/json", "x-t1-request-id": member.startKey } });
          patch(member.id, { run: value.run, status: "submitted", error: undefined }); onStarted(value.run);
        } catch (cause) { patch(member.id, { status: "startFailed", error: errorText(cause) }); }
      }
    } finally { busyRef.current = false; setPhase(null); }
  }

  return <section className="t1-upload t1-batch" aria-label={t("t1.batchTitle")} aria-busy={busy}>
    <h2>{t("t1.uploadTitle")}</h2><p className="t1-lead">{t("t1.batchHelp")}</p>
    <div className="t1-file-choices">
      <button className="t1-button" disabled={busy || Boolean(savedScope) || members.length >= MAX_FILES} onClick={() => inputRef.current?.click()}>{t("t1.chooseFiles")}</button>
      <button className="t1-button" disabled={busy || Boolean(savedScope) || members.length >= MAX_FILES} onClick={chooseFolder}>{t("t1.chooseFolder")}</button>
      <input hidden aria-label={t("t1.choosePdf")} type="file" accept="application/pdf,.pdf" multiple ref={inputRef} disabled={busy || Boolean(savedScope)} onChange={event => choose(event.target.files)} />
      <input hidden aria-label={t("t1.chooseFolder")} type="file" multiple {...{ webkitdirectory: "" }} ref={folderRef} disabled={busy || Boolean(savedScope)} onChange={event => choose(event.target.files, true)} />
    </div><p className="t1-footnote">{t("t1.folderHelp")}</p>
    {notice && <p className="t1-notice" role="status">{notice}</p>}
    {!!members.length && <>
      <p className="t1-batch-counts" role="status">{t("t1.batchCounts", { total: members.length, uploaded, submitted })}{validMembers.length > 0 && <> · <TaskKindBadge kind={taskKind} /></>}</p>
      <ul className="t1-batch-members">{members.map(member => {
        const run = runs.find(run => run.run_id === member.run?.run_id) ?? member.run;
        return <li key={member.id} data-batch-member={member.id} data-upload-state={member.status}>
          <div className="t1-batch-file"><strong title={member.displayName}>{member.displayName}</strong><small>{(member.file.size / 1024 / 1024).toFixed(1)} MiB</small>{member.status !== "invalid" && <TaskKindBadge kind={run?.submission?.kind ?? taskKind} />}</div>
          {!member.paper && <label className="t1-field">{t("t1.paperTitle")}<input aria-label={`${t("t1.paperTitle")} · ${member.displayName}`} value={member.title} disabled={busy || member.status === "invalid" || member.status === "uploadFailed"} onChange={event => patch(member.id, { title: event.target.value })} maxLength={500} /></label>}
          <div className="t1-batch-member-actions"><span className="t1-batch-state" role="status">{t(`t1.batch_${member.status}`)}{run && ` · ${t(`t1.${runPresentation(run.state, undefined).statusKey}`)}`}</span>
            {member.status === "uploadFailed" && <button className="t1-button" disabled={busy} onClick={() => void upload([member])}>{t("t1.retryUpload")}</button>}
            {member.status === "startFailed" && <button className="t1-button" disabled={busy || !canStart || invalidScope} onClick={() => void start([member])}>{t("t1.retryStart")}</button>}
            {run ? <button className="t1-button" onClick={() => onView(run)}>{t("t1.viewTask")}</button> : <button className="t1-button" disabled={busy} onClick={() => setMembers(current => current.filter(item => item.id !== member.id))}>{t("t1.removeFile")}</button>}
          </div>{member.error && <p className="t1-batch-error" role="alert">{member.error}{member.status !== "invalid" && ` ${t("t1.batchRetrySafe")}`}</p>}
        </li>;
      })}</ul>
      <button className="t1-primary" disabled={busy || !uploadable.length || !canUpload} onClick={() => void upload()}>{t(phase === "upload" ? "t1.uploading" : "t1.uploadBatch", { count: uploadable.length })}</button>
    </>}
    {scope && catalog && <ScopeEditor scope={scope} data={catalog} onChange={onScopeChange} />}
    {!!members.length && <>
      <div className="t1-batch-actions">
        <button className="t1-primary" disabled={busy || !startable.length || !canStart || invalidScope} onClick={() => void start()}>{t(phase === "start" ? "t1.starting" : taskKind === "single" ? "t1.startSingle" : "t1.startBatch", { count: startable.length })}</button>
        <button className="t1-button" disabled={busy} onClick={() => { setMembers([]); setAdmission(null); setNotice(""); }}>{t("t1.clearBatch")}</button></div>
      {savedScope && <div className="t1-batch-scope"><strong>{t("t1.batchSavedScope")}</strong><ScopeSummary scope={savedScope} data={catalog} /><p className="t1-footnote">{t("t1.batchScopeHelp")}</p><p className="t1-footnote">{t("t1.batchTypeFrozen")}</p></div>}
      <p className="t1-footnote">{t("t1.batchIndependent")}</p>
    </>}
  </section>;
}
