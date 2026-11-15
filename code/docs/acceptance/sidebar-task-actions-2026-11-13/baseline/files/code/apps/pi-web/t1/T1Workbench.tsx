"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { TabBar, type Tab } from "@/components/TabBar";
import { SidebarMenu, type SidebarMenuAnchor } from "@/components/SidebarMenu";
import { SidebarToast, type SidebarToastData } from "@/components/SidebarToast";
import { PlusIcon, RefreshIcon, SearchIcon, ChevronIcon, CloseIcon, EyeIcon, MessageIcon, OpenInNewTabIcon } from "@/components/SidebarIcons";
import { GenericFileIcon } from "@/components/FileIcons";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { movePanelTab } from "@/lib/panel-tab-order";
import { getRightPanelMaxWidth, getSidebarMaxWidth } from "@/lib/panel-layout";
import { useRunEvents } from "./useRunEvents";
import { api, jsonBody, request, WorkbenchError } from "./api";
import { ScopeSummary } from "./ScopeEditor";
import { scopeProblems, type ScopeCatalog } from "./scope";
import { FigureView, Fragments } from "./EvidenceSource";
import { RecordRetention } from "./RecordRetention";
import { SourceEditor } from "./SourceEditor";
import { SameSourceMembers } from "./SameSourceMembers";
import { ResultIndex } from "./ResultIndex";
import { ModelRuntimeNotice } from "./ModelRuntimeNotice";
import { ModelSelection } from "./ModelSelection";
import { WorkbenchNotes } from "./WorkbenchNotes";
import { BatchSubmission } from "./BatchSubmission";
import { TaskKindBadge } from "./TaskKindBadge";
import { runPresentation } from "./run-presentation";
import { initialWorkbenchSelection, sidebarPaperSelection } from "./result-navigation";
import type { Scope } from "../../../packages/contracts/src/index";
import type { WorkbenchCapabilities, WorkbenchExportKind, WorkbenchPaper, WorkbenchPaperDetail, WorkbenchRun, WorkbenchRunDetail, WorkbenchScopeCatalog, WorkbenchModels } from "../../../packages/contracts/src/workbench";

const PdfSource = dynamic(() => import("./PdfSource").then(module => module.PdfSource), { ssr: false });
const terminal = new Set(["completed", "partial", "failed", "cancelled", "interrupted"]);
type RunDetail = WorkbenchRunDetail;
const exportKinds: WorkbenchExportKind[] = ["retained_jsonl", "retained_csv", "retained_package"];

function RefreshIndicator({ label }: { label: string }) {
  return <div className="t1-refresh-center" aria-hidden="true"><span><RefreshIcon size={24} className="t1-refresh-spinner" /><span className="t1-refresh-caption">{label}</span></span></div>;
}

export function T1Workbench() {
  const { t, locale, setLocale, supportedLocales } = useI18n();
  const { preference, setThemePreference } = useTheme();
  const mobile = useIsMobile(); useViewportHeight();
  const [papers, setPapers] = useState<WorkbenchPaper[]>([]), [runs, setRuns] = useState<WorkbenchRun[]>([]);
  const [capabilities, setCapabilities] = useState<WorkbenchCapabilities | null>(null), [catalog, setCatalog] = useState<ScopeCatalog | null>(null), [scope, setScope] = useState<Scope | null>(null);
  const [models, setModels] = useState<WorkbenchModels | null>(null), [modelProfileId, setModelProfileId] = useState<string | null>(null);
  const modelInitialized = useRef(false);
  const selectedModel = models?.profiles.find(profile => profile.profile_id === modelProfileId) ?? null;
  const invalidModel = Boolean(capabilities?.model_selection && !selectedModel);
  const [paperId, setPaperId] = useState(""), [runId, setRunId] = useState<string | null>(null), [historyId, setHistoryId] = useState(""), [recordId, setRecordId] = useState("");
  const [detail, setDetail] = useState<WorkbenchPaperDetail | null>(null), [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [page, setPage] = useState(1), [revision, setRevision] = useState(0), [recordQuery, setRecordQuery] = useState("");
  const [recordRole, setRecordRole] = useState("all"), [retentionView, setRetentionView] = useState("kept");
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [detailError, setDetailError] = useState("");
  const [activeTab, setActiveTab] = useState("newTask"), [tabIds, setTabIds] = useState(["newTask", "records", "figures", "tasks"]);
  const [showSource, setShowSource] = useState(false), [showSidebar, setShowSidebar] = useState(true), [showNotes, setShowNotes] = useState(false);
  const [menu, setMenu] = useState<SidebarMenuAnchor | null>(null), [toast, setToast] = useState<SidebarToastData | null>(null);
  const [starting, setStarting] = useState(false), [actionError, setActionError] = useState("");
  const startingRef = useRef(false), startRequests = useRef(new Map<string, string>());
  const [restoreFile, setRestoreFile] = useState<File | null>(null), [restoreBusy, setRestoreBusy] = useState(false), [deletePaperConfirm, setDeletePaperConfirm] = useState(false);
  const [editor, setEditor] = useState<{ run: string; record: string | null } | null>(null), [download, setDownload] = useState(""), [exportError, setExportError] = useState("");
  const refreshRunRef = useRef<{ id: string; load: () => Promise<void> } | null>(null);
  const refreshPaperRef = useRef<{ id: string; load: () => Promise<void> } | null>(null);
  const refreshWorkspaceRef = useRef<(() => Promise<void>) | null>(null);
  const selectionRef = useRef({ paperId, runId, historyId });
  selectionRef.current = { paperId, runId, historyId };
  const refreshingRef = useRef(false), runsReadVersion = useRef(0);
  const [refreshing, setRefreshing] = useState(false), [refreshMessage, setRefreshMessage] = useState<{ failed: boolean; text: string } | null>(null);
  const locatedRecordRef = useRef("");
  const initialized = useRef(false), sidebarWidth = useRef(224), sourceWidth = useRef(520);
  const sidebarMax = useCallback(() => getSidebarMaxWidth({ viewportWidth: window.innerWidth, rightPanelOpen: showSource, rightPanelWidth: sourceWidth.current }), [showSource]);
  const sourceMax = useCallback(() => getRightPanelMaxWidth({ viewportWidth: window.innerWidth, sidebarOpen: showSidebar, sidebarWidth: sidebarWidth.current }), [showSidebar]);
  const sidebar = useResizablePanel({ ariaLabel: t("t1.resizeNav"), cssVariable: "--t1-sidebar-width", defaultWidth: 224, getMaxWidth: sidebarMax, growthDirection: "right", minWidth: 180, maxWidth: 480, storageKey: "t1:pi-web:sidebar-width", widthRef: sidebarWidth });
  const source = useResizablePanel({ ariaLabel: t("t1.resizeSource"), cssVariable: "--t1-source-width", defaultWidth: 520, getMaxWidth: sourceMax, growthDirection: "left", minWidth: 300, maxWidth: 1000, storageKey: "t1:pi-web:source-width", widthRef: sourceWidth });
  const { events, connection } = useRunEvents(runId, true);
  const tabs: Tab[] = tabIds.map(id => ({ id, label: t(`t1.${id}`), filePath: t(`t1.${id}`) }));
  const selectedRun = runs.find(run => run.run_id === runId);
  const currentRun = runDetail?.run.run_id === runId ? runDetail : null;
  const displayedRun = currentRun?.run ?? selectedRun;
  const currentPaper = detail?.paper.id === paperId ? detail : null;
  const output = runId ? currentRun?.output : currentPaper?.outputs.find(item => item.id === historyId);
  const records = output?.records.filter(record => !record.deleted) ?? [];
  const query = recordQuery.trim().toLocaleLowerCase();
  const retainedStatus = (item: typeof records[number]) => item.retention?.status ?? (item.review_status === "rejected" ? "excluded" : "kept");
  const visibleRecords = records.filter(item => retainedStatus(item) === retentionView && (recordRole === "all" || (item.evidence_role ?? "primary_candidate") === recordRole) && (!query || [...item.fragments, ...item.context].some(fragment => fragment.exact_quote.toLocaleLowerCase().includes(query))));
  const keptCount = records.filter(item => retainedStatus(item) === "kept").length;
  const excludedCount = records.length - keptCount;
  const record = visibleRecords.find(item => item.id === recordId) ?? visibleRecords[0];
  const selectedRecordId = record?.id;
  const recordPosition = record ? visibleRecords.indexOf(record) : -1;
  const firstSourcePage = record?.fragments[0]?.physical_page;
  const paper = currentRun?.paper ?? currentPaper?.paper ?? papers.find(item => item.id === paperId);
  const figures = currentRun?.figures ?? currentPaper?.figures ?? [];
  const sourceStatus = currentRun?.source_status ?? currentPaper?.source_status ?? (currentPaper?.source_verified ? "valid" : "not_parsed");
  const sourceIssues = currentRun?.source_issues ?? currentPaper?.source_issues ?? [];
  const sourceBlocked = sourceStatus === "missing" || sourceStatus === "mismatch";
  const pdfUrl = currentRun?.pdf_url ?? currentPaper?.pdf_url;
  const units = currentRun?.source_units ?? currentPaper?.source_units ?? [];
  const editable = Boolean(runId && currentRun && capabilities?.persisted_review);
  const paperRuns = runs.filter(run => run.document_id === paperId);

  useEffect(() => {
    if (!refreshMessage || refreshMessage.failed) return;
    const timer = window.setTimeout(() => setRefreshMessage(null), 5000);
    return () => window.clearTimeout(timer);
  }, [refreshMessage]);
  useEffect(() => { if (mobile) setShowSidebar(false); }, [mobile]);
  useEffect(() => { setRecordQuery(""); setRecordRole("all"); setRetentionView("kept"); }, [paperId, runId, historyId]);
  useEffect(() => { setShowNotes(false); setEditor(null); setExportError(""); }, [paperId, runId, historyId]);
  // Follow a newly selected record once; polling and version updates must not
  // steal a page the reviewer selected manually.
  useEffect(() => {
    if (!selectedRecordId || !firstSourcePage) return;
    const key = `${paperId}:${runId ?? historyId}:${selectedRecordId}`;
    if (locatedRecordRef.current !== key) { locatedRecordRef.current = key; setPage(firstSourcePage); }
  }, [paperId, runId, historyId, selectedRecordId, firstSourcePage]);

  function errorText(cause: unknown) {
    if (cause instanceof WorkbenchError && ["invalid_pdf_bytes", "invalid_pdf_filename", "pdf_size_out_of_bounds"].includes(cause.code)) return t("t1.invalidPdf");
    if (cause instanceof WorkbenchError && cause.code === "invalid_paper_title") return t("t1.invalidPaperTitle");
    if (cause instanceof WorkbenchError && cause.code === "submission_payload_conflict") return t("t1.submissionConflict");
    if (cause instanceof WorkbenchError && cause.code === "submission_result_deleted") return t("t1.submissionDeleted");
    if (cause instanceof WorkbenchError && cause.code === "submission_busy") return t("t1.submissionBusy");
    if (cause instanceof WorkbenchError && ["invalid_model_profile", "model_profile_limit"].includes(cause.code)) return t("t1.invalidModelProfile");
    if (cause instanceof WorkbenchError && ["invalid_model_profile_id", "model_profile_not_found"].includes(cause.code)) return t("t1.missingSavedModel");
    if (cause instanceof WorkbenchError && cause.code.includes("source_glyph_check_missing")) return t("t1.sourceGlyphLegacy");
    if (cause instanceof WorkbenchError && cause.code.includes("source_glyph_fidelity_unverified")) return t("t1.sourceGlyphUnreliable");
    if (cause instanceof WorkbenchError && cause.code === "restore_requires_identical_pdf") return t("t1.restoreMismatch");
    if (cause instanceof WorkbenchError && cause.code === "paper_has_active_runs") return t("t1.activePaperDelete");
    if (cause instanceof WorkbenchError && cause.code.startsWith("source_integrity_blocked")) return t("t1.sourceProblem");
    if (cause instanceof WorkbenchError) return cause.status === 502 ? t("t1.backendUnavailable") : cause.status === 404 ? t("t1.notFound") : cause.status === 409 ? t("t1.conflict") : cause.code;
    if (cause instanceof TypeError) return t("t1.connectionInterrupted");
    return cause instanceof Error ? cause.message : t("t1.requestFailed");
  }
  function openTab(id: string) { setTabIds(current => current.includes(id) ? current : [...current, id]); setActiveTab(id); }
  function chooseModel(id: string) { setModelProfileId(id); try { localStorage.setItem("t1:extraction-model-profile", id); } catch { /* In-memory selection still works. */ } }
  function selectPaper(id: string) { const selected = sidebarPaperSelection(id, runs, selectionRef.current); setDeletePaperConfirm(false); setRestoreFile(null); setPaperId(id); setRunId(selected.runId); setHistoryId(selected.historyId); setRecordId(""); setRunDetail(null); setShowSource(false); setPage(1); setActionError(""); openTab("records"); if (mobile) setShowSidebar(false); }
  function selectRun(run: WorkbenchRun) { setDeletePaperConfirm(false); setRestoreFile(null); setPaperId(run.document_id); setRunId(run.run_id); setHistoryId(""); setRecordId(""); setPage(1); setActionError(""); openTab("records"); }
  function sourcePage(value: number) { setPage(value); setShowSource(true); if (window.matchMedia("(max-width: 900px)").matches && pdfUrl) window.open(`${pdfUrl}#page=${value}`, "_blank", "noopener,noreferrer"); }
  const refresh = () => setRevision(value => value + 1);
  const reloadCurrent = async () => { await refreshRunRef.current?.load(); };

  async function refreshWorkspace() {
    if (refreshingRef.current || loading) return;
    refreshingRef.current = true; setRefreshing(true); setRefreshMessage(null);
    try {
      // A selection can change during a read. Finish reading the latest selection
      // before reporting success; aborted reads belong to their former selection.
      const same = (a: typeof selectionRef.current, b: typeof selectionRef.current) => a.paperId === b.paperId && a.runId === b.runId && a.historyId === b.historyId;
      let workspace = refreshWorkspaceRef.current;
      while (workspace) {
        try { await workspace(); } catch (cause) { if (workspace === refreshWorkspaceRef.current) throw cause; }
        if (workspace === refreshWorkspaceRef.current) break;
        workspace = refreshWorkspaceRef.current;
      }
      while (true) {
        const selected = selectionRef.current, paperRead = refreshPaperRef.current, runRead = refreshRunRef.current;
        if (selected.paperId && paperRead?.id !== selected.paperId || selected.runId && runRead?.id !== selected.runId) { await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())); continue; }
        try {
          const reads = await Promise.allSettled([selected.paperId ? paperRead?.load() : undefined, selected.runId ? runRead?.load() : undefined]);
          for (const read of reads) if (read.status === "rejected") throw read.reason;
        }
        catch (cause) { if (same(selected, selectionRef.current)) throw cause; }
        if (same(selected, selectionRef.current) && runRead === refreshRunRef.current && paperRead === refreshPaperRef.current) break;
      }
      setRefreshMessage({ failed: false, text: t("t1.refreshDone") });
    } catch (cause) { setRefreshMessage({ failed: true, text: t("t1.refreshFailed", { reason: errorText(cause) }) }); }
    finally { refreshingRef.current = false; setRefreshing(false); }
  }


  useEffect(() => {
    const controller = new AbortController(); let flight: Promise<void> | null = null;
    function load() {
      if (flight) return flight;
      const version = ++runsReadVersion.current;
      flight = Promise.all([api<WorkbenchCapabilities>("workbench/capabilities", { signal: controller.signal }), api<{ papers: WorkbenchPaper[] }>("workbench/papers", { signal: controller.signal }), api<{ runs: WorkbenchRun[] }>("workbench/runs", { signal: controller.signal }), api<WorkbenchScopeCatalog>("workbench/catalog", { signal: controller.signal }), api<WorkbenchModels>("workbench/models", { signal: controller.signal })])
      .then(([caps, listed, tasks, rawChoices, availableModels]) => {
        if (controller.signal.aborted) return;
        const choices: ScopeCatalog = { ...rawChoices, catalog: rawChoices };
        setCapabilities(caps); setPapers(listed.papers); if (version === runsReadVersion.current) setRuns(tasks.runs); setCatalog(choices); setScope(current => current ?? choices.default_scope); setError("");
        setModels(availableModels);
        if (!modelInitialized.current) {
          let saved: string | null = null; try { saved = localStorage.getItem("t1:extraction-model-profile"); } catch { /* A fresh selection uses the configured default. */ }
          setModelProfileId(saved ?? availableModels.default_profile_id); modelInitialized.current = true;
        }
        if (!initialized.current) {
          const selected = initialWorkbenchSelection(new URLSearchParams(window.location.search), listed.papers, tasks.runs);
          setPaperId(selected.paperId); setRunId(selected.runId); setHistoryId(selected.historyId); setRecordId(selected.recordId); setActiveTab(selected.activeTab);
          initialized.current = true;
        }
      }).catch(cause => { if (!controller.signal.aborted && !refreshingRef.current) setError(errorText(cause)); throw cause; }).finally(() => { flight = null; if (!controller.signal.aborted) setLoading(false); });
      return flight;
    }
    refreshWorkspaceRef.current = load; void load().catch(() => {});
    return () => { controller.abort(); if (refreshWorkspaceRef.current === load) refreshWorkspaceRef.current = null; };
    // Locale changes do not restart task I/O.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  useEffect(() => {
    if (!paperId) { refreshPaperRef.current = null; return; }
    const controller = new AbortController(); let flight: Promise<void> | null = null; setDetailError("");
    function load() {
      if (flight) return flight;
      flight = api<WorkbenchPaperDetail>(`workbench/papers/${encodeURIComponent(paperId)}`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      setDetail(value);
      if (!selectionRef.current.runId) setHistoryId(current => value.outputs.some(item => item.id === current) ? current : value.outputs.find(item => item.strategy === "B0")?.id ?? value.outputs[0]?.id ?? "");
      }).catch(cause => { if (!controller.signal.aborted && !refreshingRef.current) setDetailError(errorText(cause)); throw cause; }).finally(() => { flight = null; });
      return flight;
    }
    const reader = { id: paperId, load }; refreshPaperRef.current = reader; void load().catch(() => {});
    return () => { controller.abort(); if (refreshPaperRef.current === reader) refreshPaperRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId, revision]);
  useEffect(() => {
    if (!runId) { refreshRunRef.current = null; return; }
    const controller = new AbortController(); let flight: Promise<void> | null = null, dirty = false;
    setDetailError("");
    async function load() {
      if (controller.signal.aborted) return;
      if (flight) { dirty = true; return flight; }
      flight = (async () => {
        do {
          dirty = false;
          try {
            const value = await api<RunDetail>(`workbench/runs/${encodeURIComponent(runId!)}`, { signal: controller.signal });
            if (!controller.signal.aborted) { setRunDetail(value); setDetailError(""); setPapers(current => current.map(paper => paper.id === value.paper.id ? value.paper : paper)); }
          } catch (cause) { if (!controller.signal.aborted && !refreshingRef.current) setDetailError(errorText(cause)); throw cause; }
        } while (dirty && !controller.signal.aborted);
      })();
      try { await flight; } finally { flight = null; }
    }
    const reader = { id: runId, load }; refreshRunRef.current = reader; void load().catch(() => {});
    const timer = window.setInterval(() => { if (document.visibilityState === "visible" && !refreshingRef.current) void load().catch(() => {}); }, 10000);
    return () => { controller.abort(); window.clearInterval(timer); if (refreshRunRef.current === reader) refreshRunRef.current = null; };
    // Selection changes abort their own reads. Events and polling coalesce behind one request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, revision]);
  useEffect(() => {
    if (!initialized.current) return;
    const params = new URLSearchParams();
    if (paperId) params.set("paper", paperId);
    if (runId) params.set("run", runId); else if (historyId) params.set("history", historyId);
    if (recordId) params.set("record", recordId);
    params.set("view", activeTab);
    window.history.replaceState(null, "", `/?${params}`);
  }, [paperId, runId, historyId, recordId, activeTab]);
  const lastEvent = events.at(-1)?.seq ?? 0;
  useEffect(() => {
    if (!lastEvent) return;
    const timer = window.setTimeout(() => { if (!refreshingRef.current) void refreshRunRef.current?.load().catch(() => {}); }, 350);
    return () => clearTimeout(timer);
  }, [lastEvent]);
  useEffect(() => {
    const controller = new AbortController(); let busy = false;
    const timer = window.setInterval(async () => {
      if (busy || refreshingRef.current || document.visibilityState !== "visible") return;
      busy = true; const version = ++runsReadVersion.current;
      try { const listed = await api<{ runs: WorkbenchRun[] }>("workbench/runs", { signal: controller.signal }); if (!controller.signal.aborted && version === runsReadVersion.current) setRuns(listed.runs); }
      catch { /* The selected run has its own visible connection and read errors. */ }
      finally { busy = false; }
    }, 10000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);


  async function startRun() {
    if (startingRef.current || !paperId || !scope || !catalog || invalidModel || scopeProblems(scope, catalog).length) return;
    startingRef.current = true;
    const request = `${paperId}:${JSON.stringify(scope)}:${selectedModel?.profile_id ?? ""}`;
    const key = startRequests.current.get(request) ?? crypto.randomUUID(); startRequests.current.set(request, key);
    setStarting(true); setActionError("");
    try {
      const value = await api<{ run: WorkbenchRun }>(`workbench/papers/${encodeURIComponent(paperId)}/runs`, { ...jsonBody("POST", { scope, submission: { kind: "single" }, ...(selectedModel ? { model_profile_id: selectedModel.profile_id } : {}) }), headers: { "content-type": "application/json", "x-t1-request-id": key } });
      startRequests.current.delete(request);
      selectRun(value.run); refresh();
    } catch (cause) { setActionError(`${errorText(cause)} ${t("t1.batchRetrySafe")}`); } finally { startingRef.current = false; setStarting(false); }
  }
  async function cancelRun(id: string) {
    try { setActionError(""); await api(`workbench/runs/${encodeURIComponent(id)}/cancel`, jsonBody("POST", {})); await reloadCurrent(); } catch (cause) { setActionError(errorText(cause)); }
  }
  async function downloadExport(kind: WorkbenchExportKind) {
    if (!runId) return;
    setDownload(kind); setExportError("");
    try {
      const response = await request(`workbench/runs/${encodeURIComponent(runId)}/exports/${kind}`), blob = await response.blob();
      const url = URL.createObjectURL(blob), anchor = document.createElement("a"); anchor.href = url;
      anchor.download = `${paperId}-${runId}-${kind}.${kind.endsWith("package") ? "tar.gz" : kind.endsWith("csv") ? "csv" : "jsonl"}`;
      anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setExportError(errorText(cause)); } finally { setDownload(""); }
  }
  async function restoreOriginal() {
    if (!restoreFile || restoreFile.size > 50 * 1024 * 1024) return;
    setRestoreBusy(true); setActionError("");
    try { await api(`workbench/papers/${encodeURIComponent(paperId)}/pdf`, { method: "PUT", headers: { "content-type": "application/pdf" }, body: restoreFile }); setRestoreFile(null); await reloadCurrent(); }
    catch (cause) { setActionError(errorText(cause)); } finally { setRestoreBusy(false); }
  }
  async function deletePaper() {
    try { await api(`workbench/papers/${encodeURIComponent(paperId)}`, jsonBody("DELETE", {})); setPaperId(""); setRunId(null); setDetail(null); setRunDetail(null); setDeletePaperConfirm(false); openTab("newTask"); refresh(); }
    catch (cause) { setActionError(errorText(cause)); }
  }
  function sourceIssueText(issue: string) {
    return t(issue.startsWith("pdf_") ? issue.includes("missing") ? "t1.pdfMissing" : "t1.pdfChanged" : issue.startsWith("ir_") ? "t1.irProblem" : "t1.bindingProblem");
  }
  const state = currentRun?.run.state ?? selectedRun?.state ?? output?.state;
  const presentation = runPresentation(state, output?.coverage);
  function runLabel(run: WorkbenchRun) {
    const saved = currentRun?.run.run_id === run.run_id ? currentRun.output : currentPaper?.outputs.find(item => item.id === run.run_id);
    return t(`t1.${runPresentation(run.state, saved?.coverage).statusKey}`);
  }
  const selectedEditorRecord = editor?.record ? records.find(item => item.id === editor.record) ?? null : null;

  return <div className="t1-workbench" ref={sidebar.panelRef} data-source-open={showSource && Boolean(pdfUrl)}>
    <header className="t1-topbar"><div className="t1-brand"><span>T1</span><strong>{t("t1.title")}</strong></div>
      <div className="t1-top-actions"><select aria-label={t("t1.language")} value={locale} onChange={e => setLocale(e.target.value as typeof locale)}>{supportedLocales.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select><button onClick={() => void refreshWorkspace()} disabled={loading || refreshing} aria-busy={refreshing} aria-label={t(refreshing ? "t1.refreshing" : "t1.refresh")} title={t(refreshing ? "t1.refreshing" : "t1.refresh")}><RefreshIcon size={16} /></button><button aria-label={t("t1.theme")} title={t("t1.theme")} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ kind: "rect", rect, align: "end" }); }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M20.8 13.2A9 9 0 0 1 10.8 3.1 9 9 0 1 0 20.8 13.2Z" /></svg></button></div>
    </header>
    <span className="t1-sr-only" role="status" aria-live="polite">{refreshing ? t("t1.refreshing") : ""}</span>
    {refreshMessage && <div className="t1-refresh-toast" data-failed={refreshMessage.failed} role={refreshMessage.failed ? "alert" : "status"}><span>{refreshMessage.text}</span>{refreshMessage.failed && <button className="t1-button" onClick={() => void refreshWorkspace()}>{t("t1.retry")}</button>}<button className="t1-refresh-dismiss" aria-label={t("t1.close")} onClick={() => setRefreshMessage(null)}><CloseIcon size={14} /></button></div>}
    <div className="t1-body" ref={source.panelRef}>
      {showSidebar && <><aside className="t1-sidebar" aria-label={t("t1.paperNav")}><div className="t1-sidebar-heading"><strong>{t("t1.papers")}</strong><span>{papers.length}</span><button className="t1-sidebar-close" aria-label={t("t1.close")} onClick={() => setShowSidebar(false)}><CloseIcon size={18} /></button></div>
        <button className="t1-new-task" onClick={() => { openTab("newTask"); if (mobile) setShowSidebar(false); }}><PlusIcon size={16} />{t("t1.newTask")}</button>
        <div className="t1-paper-list-region" aria-busy={refreshing}><div className="t1-paper-list">{papers.map(item => {
          const selected = sidebarPaperSelection(item.id, runs, selectionRef.current);
          const run = runs.find(run => run.run_id === selected.runId && run.document_id === item.id);
          return <button key={item.id} data-paper-id={item.id} data-sidebar-run-id={selected.runId ?? undefined} className={paperId === item.id ? "selected" : ""} aria-current={paperId === item.id ? "page" : undefined} title={item.title} onClick={() => selectPaper(item.id)}><span className="t1-paper-label"><GenericFileIcon size={14} /><b>{item.uploaded || item.id.startsWith("paper-") ? t("t1.uploadedPaper") : item.id}</b><small>{item.pages || "—"} {t("t1.pagesShort")}</small></span><strong>{item.title}</strong>{(selected.runId || selected.historyId || item.output_ids.length > 0) && <span className="t1-paper-meta"><TaskKindBadge kind={run?.submission?.kind} /></span>}<em>{item.uploaded ? "PDF" : t("t1.historical")}</em></button>;
        })}</div>{refreshing && <div className="t1-refresh-overlay" aria-hidden="true" />}</div>
        <div className="t1-sidebar-bottom"><button onClick={() => openTab("tasks")}><MessageIcon size={15} />{t("t1.tasks")}</button><details><summary>{t("t1.aboutWorkbench")}</summary><span>Pi Web 0.15.0 · T1 Pi SDK 1.4.0</span></details></div>
        <SidebarToast toast={toast} onDismiss={() => setToast(null)} dismissLabel={t("t1.close")} /></aside><div className="t1-resize" {...sidebar.separatorProps} /></>}
      <main className="t1-main"><div className="t1-workspace-bar"><button onClick={() => setShowSidebar(value => !value)} aria-label={t("t1.toggleNav")} title={t("t1.toggleNav")} aria-expanded={showSidebar}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg></button><span title={paper?.title}>{paper?.title ?? t("t1.newTask")}</span><button className="t1-source-toggle" aria-pressed={showSource} onClick={() => setShowSource(value => !value)}><EyeIcon size={15} />{t(showSource ? "t1.hideOriginal" : "t1.showOriginal")}</button>{pdfUrl && <a className="t1-mobile-source" href={`${pdfUrl}#page=${page}`} target="_blank" rel="noreferrer"><OpenInNewTabIcon size={14} />{t("t1.openOriginal")}</a>}</div>
        <TabBar tabs={tabs} activeTabId={activeTab} onSelectTab={setActiveTab} onCloseTab={id => { const next = tabIds.filter(tab => tab !== id); setTabIds(next); if (activeTab === id) setActiveTab(next[0] ?? ""); }} onReorderTab={(from, to, after) => setTabIds(current => movePanelTab(current, from, to, after))} />
        <div className="t1-content-region" aria-busy={refreshing}><div className="t1-content" data-view={activeTab} data-source-blocked={sourceBlocked}>
          {loading && <p className="t1-status" role="status">{t("t1.loading")}</p>}
          {error && <div className="t1-alert" role="alert">{error}<button onClick={refresh}>{t("t1.retry")}</button></div>}
          {actionError && <div className="t1-alert" role="alert">{actionError}</div>}
          {detailError && activeTab !== "newTask" && <div className="t1-alert" role="alert">{detailError}<button onClick={refresh}>{t("t1.retry")}</button></div>}
          {sourceBlocked && <div className="t1-alert" role="alert">{t("t1.sourceProblem")}{[...new Set(sourceIssues.map(sourceIssueText))].map((issue, i) => <p key={i}>{issue}</p>)}<details><summary>{t("t1.sourceVersion")}</summary>{sourceIssues.join(" · ")}</details></div>}
          {sourceBlocked && paper && <section className="t1-source-recovery"><p>{t("t1.restoreHelp")}</p><label className="t1-field">{t("t1.selectRestorePdf")}<input type="file" accept="application/pdf,.pdf" aria-label={t("t1.selectRestorePdf")} onChange={e => setRestoreFile(e.target.files?.[0] ?? null)} /></label><button className="t1-primary" disabled={!restoreFile || restoreBusy} onClick={() => void restoreOriginal()}>{t("t1.restorePdf")}</button></section>}
          {capabilities?.controlled_fixture && <p className="t1-fixture-banner">{t("t1.fixture")}</p>}
          {!activeTab && <div className="t1-empty">{["newTask", "records", "figures", "tasks"].map(id => <button key={id} onClick={() => openTab(id)}>{t(`t1.${id}`)}</button>)}</div>}
          <section className="t1-new-task-panel" hidden={activeTab !== "newTask"}><div className="t1-heading"><h1>{t("t1.newTask")}</h1><span className="t1-badge">B0</span></div>
            {capabilities?.model_selection && models && <ModelSelection models={models} value={modelProfileId} onChange={chooseModel} onModelsChange={setModels} errorText={errorText} />}
            <BatchSubmission scope={scope} catalog={catalog} onScopeChange={setScope} canUpload={Boolean(capabilities?.paper_upload)} canStart={Boolean(capabilities?.extraction_start)} runs={runs} modelProfile={selectedModel} modelRequired={Boolean(capabilities?.model_selection)} errorText={errorText}
              onUploaded={paper => { setPapers(current => [paper, ...current.filter(item => item.id !== paper.id)]); setPaperId(current => current || paper.id); }}
              onStarted={run => setRuns(current => [run, ...current.filter(item => item.run_id !== run.run_id)])} onView={selectRun} />
            <h2>{t("t1.singlePaperTask")}</h2>
            <label className="t1-field">{t("t1.selectPaper")}<select aria-label={t("t1.selectPaper")} value={paperId} onChange={e => { setPaperId(e.target.value); setRunId(null); setRunDetail(null); }}><option value="">{t("t1.choosePaper")}</option>{papers.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
            {!capabilities?.extraction_start && <p className="t1-notice">{t("t1.extractionUnavailable")}{capabilities?.extraction_unavailable_reason && capabilities.extraction_unavailable_reason !== "server_model_not_enabled" && <small>{capabilities.extraction_unavailable_reason}</small>}</p>}
            <button className="t1-primary t1-start" disabled={starting || !paperId || !scope || !catalog || invalidModel || !capabilities?.extraction_start || sourceBlocked || scopeProblems(scope, catalog).length > 0} onClick={() => void startRun()}>{t(starting ? "t1.starting" : "t1.start")}</button>
            <ModelRuntimeNotice runtime={invalidModel ? undefined : capabilities?.model_runtime && selectedModel ? { ...capabilities.model_runtime, model_id: selectedModel.model_id, provider: selectedModel.provider, reasoning_effort: selectedModel.reasoning_effort === "none" ? t("t1.noReasoningParameter") : selectedModel.reasoning_effort } : capabilities?.model_runtime} maxConcurrent={capabilities?.max_concurrent_runs} />
          </section>
          {activeTab === "records" && <>
            <div className="t1-heading t1-results-heading"><h1>{t("t1.extractionResults")}</h1>
              <div className="t1-output-toolbar"><details className="t1-task-picker"><summary>{t("t1.task")} {selectedRun?.created_at && <time dateTime={selectedRun.created_at}>{new Date(selectedRun.created_at).toLocaleDateString(locale)}</time>}</summary><label>{t("t1.task")}<select aria-label={t("t1.task")} value={runId ? `run:${runId}` : `history:${historyId}`} onChange={e => { const value = e.target.value; setRecordId(""); if (value.startsWith("run:")) { setRunId(value.slice(4)); setHistoryId(""); } else { setRunId(null); setHistoryId(value.slice(8)); } }}>
                {!paperRuns.length && !currentPaper?.outputs.length && <option value="history:">{t("t1.noTasks")}</option>}{paperRuns.map(run => <option key={run.run_id} value={`run:${run.run_id}`}>{run.created_at ? new Date(run.created_at).toLocaleString(locale) : t("t1.task")} · {t("t1.recordCount", { count: run.candidate_count })}{run.fixture ? ` · ${t("t1.controlledTask")}` : ""}</option>)}{currentPaper?.outputs.filter(item => item.origin === "historical_compatibility_replay" && !paperRuns.some(run => run.run_id === item.id)).map(item => <option key={item.id} value={`history:${item.id}`}>{t("t1.historical")} · {item.strategy} · {item.records.length}</option>)}</select></label></details>
                {state && <div className="t1-task-progress" role="status" data-state={state} data-status={presentation.statusKey}><button className="t1-status-button" onClick={() => setShowNotes(true)}><span className="t1-status-dot" />{t(`t1.${presentation.statusKey}`)}</button>{runId && !terminal.has(state) && <button className="t1-button" onClick={() => void cancelRun(runId)}>{t("t1.cancel")}</button>}</div>}
                {presentation.sourceLimited && <button className="t1-source-limits-chip" onClick={() => setShowNotes(true)}>{t("t1.sourceLimitsBadge")}</button>}
              </div>
              <div className="t1-results-actions"><button className="t1-button t1-notes-toggle" aria-haspopup="dialog" aria-expanded={showNotes} onClick={() => setShowNotes(true)}><MessageIcon size={14} />{t("t1.notes")}</button>
                {runId && currentRun && <details className="t1-exports"><summary><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5" /></svg>{t("t1.exportTitle")}<ChevronIcon size={12} /></summary><div className="t1-export-options" aria-label={t("t1.exportFormat")}>{exportKinds.map(kind => <button key={kind} disabled={Boolean(download) || sourceBlocked || !capabilities?.retained_export || keptCount === 0} onClick={() => void downloadExport(kind)}>{t(`t1.${kind}`)}</button>)}</div></details>}
              </div>
            </div>
            {exportError && <div className="t1-alert t1-export-error" role="alert">{exportError}<button className="t1-button" onClick={() => { setExportError(""); setShowNotes(true); }}>{t("t1.viewDetails")}</button></div>}
            {download && <span className="t1-sr-only" role="status">{t("t1.downloading")}</span>}
            <section className="t1-results-panel" aria-label={t("t1.extractionResults")}>
              <div className="t1-record-nav"><div className="t1-retention-views" aria-label={t("t1.retentionViews")}>{["kept", "excluded"].map(view => <button key={view} data-retention-view={view} aria-pressed={retentionView === view} onClick={() => { setRetentionView(view); setRecordId(""); }}>{t(view === "kept" ? "t1.keptResults" : "t1.excluded")}<span data-retention-count={view}>{view === "kept" ? keptCount : excludedCount}</span></button>)}</div>
                <label className="t1-record-search"><SearchIcon size={14} /><input type="search" aria-label={t("t1.findRecord")} placeholder={t("t1.findRecord")} value={recordQuery} onChange={e => setRecordQuery(e.target.value)} /></label>
                <label className="t1-role-filter"><span className="t1-sr-only">{t("t1.candidateRole")}</span><select aria-label={t("t1.candidateRole")} value={recordRole} onChange={e => { setRecordRole(e.target.value); setRecordId(""); }}><option value="all">{t("t1.allCandidates")}</option><option value="primary_candidate">{t("t1.primaryDescriptions")}</option><option value="background_suggestion">{t("t1.backgroundSuggestions")}</option></select></label>
              </div>
              {!records.length ? <div className="t1-empty"><p>{t(output ? "t1.noRecords" : "t1.noRun")}</p><button onClick={() => openTab("newTask")}>{t("t1.newTask")}</button></div> : <>
                <div className="t1-record-step"><label className="t1-record-selector"><span className="t1-sr-only">{t("t1.record")}</span><select aria-label={t("t1.record")} value={record?.id ?? ""} onChange={e => setRecordId(e.target.value)}>{!visibleRecords.length && <option value="">{t("t1.noMatchingRecords")}</option>}{visibleRecords.map(item => <option key={item.id} value={item.id}>{records.indexOf(item) + 1} · {item.fragments[0]?.exact_quote.slice(0, 82)}</option>)}</select></label><span className="t1-record-position">{recordPosition + 1} / {visibleRecords.length}</span><button aria-label={t("t1.previousRecord")} title={t("t1.previousRecord")} disabled={recordPosition <= 0} onClick={() => setRecordId(visibleRecords[recordPosition - 1].id)}><ChevronIcon size={15} className="t1-chevron-back" /></button><button aria-label={t("t1.nextRecord")} title={t("t1.nextRecord")} disabled={recordPosition < 0 || recordPosition >= visibleRecords.length - 1} onClick={() => setRecordId(visibleRecords[recordPosition + 1].id)}><ChevronIcon size={15} /></button></div>
                {!visibleRecords.length ? <p className="t1-empty t1-search-empty" role="status">{t("t1.noMatchingRecords")}</p> : <div className="t1-results-layout"><ResultIndex records={records} visibleRecords={visibleRecords} selectedId={record?.id} onSelect={setRecordId} />
                  {record && <article className="t1-evidence-card" data-record-id={record.id} data-record-version={record.version}>
                    <div className="t1-reader-scroll" key={record.id}><div className="t1-record-meta"><span className="t1-record-number">{String(records.indexOf(record) + 1).padStart(2, "0")}</span><h2>{t(record.evidence_role === "background_suggestion" ? "t1.backgroundSource" : "t1.descriptionSource")}</h2>{firstSourcePage && <button className="t1-button t1-locate" onClick={() => sourcePage(firstSourcePage)}><EyeIcon size={14} />{t("t1.locateSource")}</button>}</div>
                      <div className="t1-quote-frame"><Fragments fragments={record.fragments} passages={record.passages} onPage={sourcePage} /></div>
                      {!!record.context.length && <details className="t1-context" key={`${record.id}:context`}><summary>{t("t1.context", { count: record.context.length })}</summary><Fragments fragments={record.context} passages={record.context_passages} onPage={sourcePage} /></details>}
                      {record.association === "paired" && <details open className="t1-association" data-pairing="paired" key={`${record.id}:figures`}><summary><strong>{t("t1.pairedFigureCount", { count: record.figure_ids.length })}</strong></summary>{record.figure_ids.map(id => { const figure = figures.find(item => item.id === id); return figure ? <FigureView key={id} figure={figure} onPage={sourcePage} paired /> : null; })}</details>}
                    </div>
                    {editable && capabilities?.persisted_retention && <RecordRetention key={`${runId}:${record.id}:${record.version}:${record.retention?.revision ?? 0}`} runId={runId!} record={record} onNext={recordPosition < visibleRecords.length - 1 ? () => setRecordId(visibleRecords[recordPosition + 1].id) : undefined} onSaved={async changed => { if (changed) setRecordId(visibleRecords[recordPosition + 1]?.id ?? visibleRecords[recordPosition - 1]?.id ?? ""); await reloadCurrent(); }} />}
                  </article>}
                </div>}
              </>}
            </section>
          </>}
          {activeTab === "figures" && <><div className="t1-heading"><h1>{t("t1.figures")}</h1></div><p className="t1-lead">{t("t1.independentFigure")}</p>{figures.length ? figures.map(figure => <FigureView key={figure.id} figure={figure} onPage={sourcePage} />) : <p className="t1-empty">{t("t1.noFigures")}</p>}</>}
          {activeTab === "tasks" && <><div className="t1-heading"><h1>{t("t1.tasks")}</h1></div><p className="t1-lead">{t("t1.separateTasks")}</p><div className="t1-run-list">{runs.length ? runs.map(run => <div className="t1-task-row" key={run.run_id}><button onClick={() => selectRun(run)}><strong>{papers.find(item => item.id === run.document_id)?.title ?? run.document_id}</strong><span>{runLabel(run)} · {run.candidate_count}{run.fixture && " · fixture"}</span><small>{run.created_at ? new Date(run.created_at).toLocaleString(locale) : ""}</small></button>{!terminal.has(run.state) && <button onClick={() => void cancelRun(run.run_id)}>{t("t1.cancel")}</button>}<details><summary>{t("t1.sourceVersion")}</summary><code>{run.run_id}</code>{run.model_id && <p data-run-model={run.model_id}>{t("t1.extractionModel")}: {run.model_id}{run.model_profile && ` · ${run.model_profile.api} · ${run.model_profile.reasoning_effort === "none" ? t("t1.noReasoningParameter") : run.model_profile.reasoning_effort}`}</p>}</details></div>) : <p>{t("t1.noTasks")}</p>}</div>
            {paper && <details className="t1-context"><summary>{t("t1.deletePaper")}</summary><p>{t("t1.deletePaperHelp")}</p><button onClick={() => setDeletePaperConfirm(true)}>{t("t1.deletePaper")}</button>{deletePaperConfirm && <button onClick={() => void deletePaper()}>{t("t1.confirmDeletePaper")}</button>}</details>}
            <h2>{t("t1.events")}</h2><div className="t1-stream-status" role="status">{t(`t1.${connection}`)}</div>{events.length ? <ol className="t1-events">{events.map(event => <li key={event.seq}><span>#{event.seq} · {event.type}</span><p>{event.summary}</p><time>{event.timestamp}</time></li>)}</ol> : <p>{t("t1.noEvents")}</p>}
          </>}
        </div>{refreshing && <div className="t1-refresh-overlay" aria-hidden="true" />}</div>
      </main>
      {showSource && paper && pdfUrl && <><div className="t1-resize" {...source.separatorProps} /><aside className="t1-source" aria-label={t("t1.originalPdf")}><div className="t1-source-heading"><strong><GenericFileIcon size={15} />{t("t1.originalPdf")}</strong><a href={`${pdfUrl}#page=${page}`} target="_blank" rel="noreferrer">{t("t1.openOriginal")}<OpenInNewTabIcon size={13} /></a></div>{sourceBlocked ? <p className="t1-alert">{t("t1.sourceProblem")}</p> : <PdfSource key={`${paper.id}:${paper.sha256}`} url={pdfUrl} sha256={paper.sha256} page={page} pages={paper.pages} onPage={sourcePage} />}<div className="t1-source-footer"><small>{t("t1.sourceUnchanged")}</small><details><summary>{t("t1.sourceVersion")}</summary><code>SHA256 {paper.sha256}</code></details></div></aside></>}
      {refreshing && <RefreshIndicator label={t("t1.refreshing")} />}
    </div>
    <WorkbenchNotes open={showNotes} title={t(editor ? "t1.editTitle" : "t1.notes")} onClose={() => { setShowNotes(false); setEditor(null); }}>
      {editor && editor.run === runId && !sourceBlocked ? <SourceEditor key={`${editor.run}:${editor.record ?? "new"}`} runId={editor.run} record={selectedEditorRecord} units={units} onPage={value => { sourcePage(value); setShowNotes(false); setEditor(null); }} onSaved={reloadCurrent} onClose={() => setEditor(null)} /> : <>
        <section className="t1-notes-section"><h3>{t("t1.systemNotes")}</h3><p>{t("t1.disclaimer")}</p>{presentation.sourceLimited && <p className="t1-notes-warning">{t("t1.sourceLimitsHint")}</p>}{runId && (!presentation.ended || !presentation.taskComplete) && <p className="t1-notes-warning">{t(`t1.${presentation.hintKey}`)}</p>}{sourceBlocked && <p className="t1-notes-warning">{t("t1.sourceProblem")}</p>}
          {record && <><h4>{t("t1.figureRelationship")}</h4><p>{t(record.association === "paired" ? "t1.pairedFigureCount" : record.association === "pending" ? "t1.pendingPair" : record.association === "not_checked" ? "t1.notChecked" : "t1.noPair", { count: record.figure_ids.length })}</p></>}
          {record?.labels?.comment && <aside className="t1-reviewer-comment"><strong>{t("t1.comment")}</strong><p>{record.labels.comment}</p></aside>}
        </section>
        <section className="t1-notes-section"><h3>{t("t1.sourceInformation")}</h3>{displayedRun?.model_id && <p data-run-model={displayedRun.model_id}>{t("t1.extractionModel")}: {displayedRun.model_id}{displayedRun.model_profile && ` · ${displayedRun.model_profile.api} · ${displayedRun.model_profile.reasoning_effort === "none" ? t("t1.noReasoningParameter") : displayedRun.model_profile.reasoning_effort}`}</p>}<p>{t("t1.fragmentsSeparate")}</p>{output?.scope && <details className="t1-note-disclosure"><summary>{t("t1.runScope")}</summary><ScopeSummary scope={output.scope} data={catalog} /></details>}
          {record && <SameSourceMembers index={output?.same_source_review_index} record={record} records={records} onSelect={id => { const member = records.find(item => item.id === id); setRecordQuery(""); setRecordRole("all"); setRetentionView(member ? retainedStatus(member) : "kept"); setRecordId(id); setShowNotes(false); }} />}
        </section>
        {editable && !sourceBlocked && <section className="t1-notes-section"><h3>{t("t1.moreActions")}</h3>{record && <button className="t1-button" onClick={() => setEditor({ run: runId!, record: record.id })}>{t("t1.sourceCorrection")}</button>}<button className="t1-button" onClick={() => setEditor({ run: runId!, record: null })}>{t("t1.add")}</button></section>}
        <details className="t1-technical-details"><summary>{t("t1.sourceLocationVersion")}</summary>{record && <><p>{t("t1.version", { version: record.version })}</p><code>{record.id} · {record.run_id} · {record.text_fingerprint}</code><h4>{t("t1.sourceDetails")}</h4>{[...record.fragments, ...record.context].map((fragment, i) => <code key={i}>{t("t1.physicalPage", { page: fragment.physical_page })} · {fragment.block_id} · {fragment.start}–{fragment.end} · {fragment.text_version}</code>)}
          <details><summary>{t("t1.originalFields")}</summary><pre>{JSON.stringify({ figure_association: record.association, proposed_figure_ids: record.proposed_figure_ids, figures: figures.filter(figure => record.figure_ids.includes(figure.id)).map(({ id, number, verification, human_approved }) => ({ id, number, verification, human_approved })) }, null, 2)}</pre>{record.reasons.map((reason, i) => <p key={i}>{reason}</p>)}{record.model_primary_assessment && <pre>{JSON.stringify(record.model_primary_assessment, null, 2)}</pre>}{record.labels && <pre>{JSON.stringify(record.labels, null, 2)}</pre>}</details>{(record.review_reason || record.text_approved || record.review_status === "rejected") && <details className="t1-legacy-review"><summary>{t("t1.legacyReviewInfo")}</summary><p>{record.review_status}</p>{record.review_reason && <p>{record.review_reason}</p>}</details>}</>}{runId && <p className="t1-stream-status">{t(`t1.${connection}`)}</p>}{paper && <code>PDF SHA256 {paper.sha256}</code>}</details>
      </>}
    </WorkbenchNotes>
    <SidebarMenu open={menu !== null} anchor={menu} sheet={mobile} ariaLabel={t("t1.theme")} title={t("t1.theme")} cancelLabel={t("t1.close")} onClose={() => setMenu(null)} items={([['auto', 'system'], ['light', 'light'], ['dark', 'dark']] as const).map(([id, key]) => ({ type: "item", id, label: t(`t1.${key}`), checked: preference === id, onSelect: () => setThemePreference(id) }))} />
  </div>;
}
