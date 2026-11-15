"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { TabBar, type Tab } from "@/components/TabBar";
import { SidebarMenu, type SidebarMenuAnchor } from "@/components/SidebarMenu";
import { SidebarToast, type SidebarToastData } from "@/components/SidebarToast";
import { PlusIcon, RefreshIcon, SearchIcon, ChevronIcon, EyeIcon, MessageIcon, OpenInNewTabIcon } from "@/components/SidebarIcons";
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
import { refreshDraftScope, type ScopeCatalog } from "./scope";
import { FigureView, Fragments } from "./EvidenceSource";
import { RecordRetention } from "./RecordRetention";
import { SourceEditor } from "./SourceEditor";
import { SameSourceMembers } from "./SameSourceMembers";
import { ResultIndex } from "./ResultIndex";
import { ModelRuntimeNotice } from "./ModelRuntimeNotice";
import { ModelSelection } from "./ModelSelection";
import { originalRunFilename, taskDisplayTitle } from "./task-titles";
import { WorkbenchNotes } from "./WorkbenchNotes";
import { BatchSubmission, type StoragePaperAvailability } from "./BatchSubmission";
import { RunTaskMenu, type RunTaskMenuState } from "./RunTaskMenu";
import { RunProgress } from "./RunProgress";
import { BatchProgress } from "./BatchProgress";
import { DetailDisclosure } from "./DetailDisclosure";
import { RunDeleteDialog, type RunDeleteTarget } from "./RunDeleteDialog";
import { SubmissionRunList } from "./SubmissionRunList";
import { groupSubmittedRuns, resultRecordKey, submissionRun, submittedTaskId } from "./submission-groups";
import { useBatchResults } from "./useBatchResults";
import { GlobalToasts } from "./GlobalToasts";
import { StorageIcon, StorageManagement } from "./StorageManagement";
import { canCancelRun, cancellationResult, runDeletionBlocked } from "./task-actions";
import { runPresentation } from "./run-presentation";
import { TaskCompletionNotes } from "./TaskCompletionNotes";
import { TableSupport } from "./TableSupport";
import { hasWorkbenchTaskContext, initialWorkbenchSelection, workbenchSelectionParams } from "./result-navigation";
import type { Scope } from "../../../packages/contracts/src/index";
import type { WorkbenchCapabilities, WorkbenchExportKind, WorkbenchPaper, WorkbenchPaperDetail, WorkbenchRun, WorkbenchRunDetail, WorkbenchScopeCatalog, WorkbenchModels } from "../../../packages/contracts/src/workbench";

const PdfSource = dynamic(() => import("./PdfSource").then(module => module.PdfSource), { ssr: false });
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
  const modelRuntime = invalidModel ? undefined : capabilities?.model_runtime && selectedModel ? { ...capabilities.model_runtime, model_id: selectedModel.model_id, provider: selectedModel.provider, reasoning_effort: selectedModel.reasoning_effort === "none" ? t("t1.noReasoningParameter") : selectedModel.reasoning_effort } : capabilities?.model_runtime;
  const [paperId, setPaperId] = useState(""), [runId, setRunId] = useState<string | null>(null), [historyId, setHistoryId] = useState(""), [recordId, setRecordId] = useState("");
  const [detail, setDetail] = useState<WorkbenchPaperDetail | null>(null), [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [runObservedAt, setRunObservedAt] = useState<{ id: string; at: number } | null>(null);
  const [page, setPage] = useState(1), [revision, setRevision] = useState(0), [recordQuery, setRecordQuery] = useState("");
  const [recordRole, setRecordRole] = useState("all"), [retentionView, setRetentionView] = useState("kept");
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [detailError, setDetailError] = useState("");
  const [activeTab, setActiveTab] = useState("newTask"), [tabIds, setTabIds] = useState(["newTask"]);
  const [submissionRevision, setSubmissionRevision] = useState(0);
  const [showSource, setShowSource] = useState(false), [showSidebar, setShowSidebar] = useState(true), [showNotes, setShowNotes] = useState(false);
  const [showStorage, setShowStorage] = useState(false);
  const [storagePaperAvailability, setStoragePaperAvailability] = useState<StoragePaperAvailability | null>(null);
  const expandNavRef = useRef<HTMLButtonElement>(null), collapseNavRef = useRef<HTMLButtonElement>(null), navFocusTarget = useRef<boolean | null>(null);
  const [menu, setMenu] = useState<SidebarMenuAnchor | null>(null), [toast, setToast] = useState<SidebarToastData | null>(null);
  const [taskMenu, setTaskMenu] = useState<RunTaskMenuState | null>(null), [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());
  const cancellingRef = useRef(new Set<string>());
  const [taskNotice, setTaskNotice] = useState<{ id: string; busy: boolean; failed: boolean; text: string } | null>(null);
  const [actionError, setActionError] = useState(""), [taskQuery, setTaskQuery] = useState("");
  const [restoreFile, setRestoreFile] = useState<File | null>(null), [restoreBusy, setRestoreBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RunDeleteTarget | null>(null), [deleteBusy, setDeleteBusy] = useState(false), [deleteError, setDeleteError] = useState("");
  const [cleanupTarget, setCleanupTarget] = useState<RunDeleteTarget | null>(null);
  const deletedRuns = useRef(new Set<string>()), deletedBatches = useRef(new Set<string>()), deletingRuns = useRef(new Set<string>());
  const runsRef = useRef(runs); runsRef.current = runs;
  const [editor, setEditor] = useState<{ run: string; record: string | null } | null>(null), [download, setDownload] = useState(""), [exportError, setExportError] = useState("");
  const refreshRunRef = useRef<{ id: string; load: () => Promise<void> } | null>(null);
  const refreshPaperRef = useRef<{ id: string; load: () => Promise<void> } | null>(null);
  const refreshWorkspaceRef = useRef<(() => Promise<void>) | null>(null);
  const selectionRef = useRef({ paperId, runId, historyId, activeTab });
  selectionRef.current = { paperId, runId, historyId, activeTab };
  const refreshingRef = useRef(false), runsReadVersion = useRef(0);
  const runMutationVersions = useRef(new Map<string, number>());
  const [refreshing, setRefreshing] = useState(false), [refreshMessage, setRefreshMessage] = useState<{ failed: boolean; text: string } | null>(null);
  const refreshBatchRef = useRef<(() => Promise<void>) | null>(null);
  const locatedRecordRef = useRef("");
  const initialized = useRef(false), sidebarWidth = useRef(224), sourceWidth = useRef(520);
  const sidebarMax = useCallback(() => getSidebarMaxWidth({ viewportWidth: window.innerWidth, rightPanelOpen: showSource, rightPanelWidth: sourceWidth.current }), [showSource]);
  const sourceMax = useCallback(() => getRightPanelMaxWidth({ viewportWidth: window.innerWidth, sidebarOpen: true, sidebarWidth: showSidebar ? sidebarWidth.current : 44 }), [showSidebar]);
  const sidebar = useResizablePanel({ ariaLabel: t("t1.resizeNav"), cssVariable: "--t1-sidebar-width", defaultWidth: 224, getMaxWidth: sidebarMax, growthDirection: "right", minWidth: 180, maxWidth: 480, storageKey: "t1:pi-web:sidebar-width", widthRef: sidebarWidth });
  const source = useResizablePanel({ ariaLabel: t("t1.resizeSource"), cssVariable: "--t1-source-width", defaultWidth: 520, getMaxWidth: sourceMax, growthDirection: "left", minWidth: 300, maxWidth: 1000, storageKey: "t1:pi-web:source-width", widthRef: sourceWidth });
  const selectedRun = runs.find(run => run.run_id === runId);
  const currentPaper = detail?.paper.id === paperId ? detail : null;
  const hasTaskContext = hasWorkbenchTaskContext({ paperId, runId, historyId }, papers, runs)
    && (!historyId || !currentPaper || currentPaper.outputs.some(output => output.id === historyId));
  const taskView = hasTaskContext && (activeTab === "records" || activeTab === "figures");
  const tabs: Tab[] = tabIds.filter(id => hasTaskContext || id !== "records" && id !== "figures").map(id => ({ id, label: t(`t1.${id}`), filePath: t(`t1.${id}`) }));
  const taskGroups = groupSubmittedRuns(runs), selectedGroup = taskGroups.find(group => group.runs.some(run => run.run_id === runId));
  const batchId = selectedRun?.submission?.kind === "batch" ? selectedRun.submission.batch_id : undefined;
  const batchResults = useBatchResults(batchId, selectedGroup?.runs ?? [], revision, errorText);
  refreshBatchRef.current = batchId ? () => batchResults.reload() : null;
  const currentRun = !selectedRun ? null : runId && batchId ? batchResults.details[runId] ?? null : runDetail?.run.run_id === runId ? runDetail : null;
  const displayedRun = batchId && selectedGroup ? submissionRun(selectedGroup) : currentRun?.run ?? selectedRun;
  const selectedOutput = runId ? currentRun?.output : currentPaper?.outputs.find(item => item.id === historyId);
  const records = (batchId ? selectedGroup?.runs.flatMap(run => batchResults.details[run.run_id]?.output.records ?? []) : selectedOutput?.records)?.filter(record => !record.deleted) ?? [];
  const query = recordQuery.trim().toLocaleLowerCase();
  const retainedStatus = (item: typeof records[number]) => item.retention?.status ?? (item.review_status === "rejected" ? "excluded" : "kept");
  const visibleRecords = records.filter(item => retainedStatus(item) === retentionView && (recordRole === "all" || (item.evidence_role ?? "primary_candidate") === recordRole) && (!query || [...item.fragments, ...item.context].some(fragment => fragment.exact_quote.toLocaleLowerCase().includes(query))));
  const keptCount = records.filter(item => retainedStatus(item) === "kept").length;
  const excludedCount = records.length - keptCount;
  const record = visibleRecords.find(item => resultRecordKey(item) === recordId || item.id === recordId && item.run_id === runId) ?? visibleRecords[0];
  const selectedRecordId = record ? resultRecordKey(record) : undefined;
  const recordDetail = batchId && record ? batchResults.details[record.run_id] : currentRun;
  const operationRunId = recordDetail?.run.run_id ?? runId;
  const { events, progressEvents, connection } = useRunEvents(taskView ? operationRunId : null, true);
  const output = recordDetail?.output ?? selectedOutput;
  // Source panels and writes follow the selected record's exact child run.
  const sourceDetail = selectedRun && recordDetail?.run.document_id === recordDetail?.paper.id ? recordDetail : null;
  const loadingRun = Boolean((batchId ? batchResults.loading : runId && !currentRun || historyId && paperId && !currentPaper) && !detailError);
  const unavailableHistory = Boolean(historyId && (!paperId || currentPaper && !output));
  const missingHistoricalSource = Boolean(historyId && output);
  const recordPosition = record ? visibleRecords.indexOf(record) : -1;
  const firstSourcePage = record?.fragments[0]?.physical_page;
  const paper = recordDetail?.paper ?? (hasTaskContext ? papers.find(item => item.id === (record?.run_id ? selectedGroup?.runs.find(run => run.run_id === record.run_id)?.document_id ?? paperId : paperId)) : undefined);
  const figures = sourceDetail?.figures ?? [];
  const sourceStatus = sourceDetail?.source_status ?? (sourceDetail && "source_verified" in sourceDetail && sourceDetail.source_verified ? "valid" : "not_parsed");
  const sourceIssues = sourceDetail?.source_issues ?? [];
  const sourceBlocked = sourceStatus === "missing" || sourceStatus === "mismatch";
  const pdfUrl = taskView && !sourceBlocked ? sourceDetail?.pdf_url : undefined;
  const units = sourceDetail?.source_units ?? [];
  const editable = Boolean(operationRunId && recordDetail && capabilities?.persisted_review);
  const paperRuns = runs.filter(run => run.document_id === paperId);
  const pairedFigures = record?.association === "paired" ? figures.filter(figure => record.figure_ids.includes(figure.id)) : [];

  useEffect(() => { if (!showSidebar) setTaskMenu(null); }, [showSidebar]);
  useEffect(() => { if (mobile) setShowSidebar(false); }, [mobile]);
  useEffect(() => {
    if (navFocusTarget.current !== showSidebar) return;
    (showSidebar ? collapseNavRef : expandNavRef).current?.focus({ preventScroll: true }); navFocusTarget.current = null;
  }, [showSidebar]);
  useEffect(() => { setRecordQuery(""); setRecordRole("all"); setRetentionView("kept"); }, [paperId, runId, historyId]);
  useEffect(() => { setShowNotes(false); setEditor(null); setExportError(""); }, [paperId, runId, historyId]);
  useEffect(() => { if (!taskView) { setShowSource(false); setShowNotes(false); setEditor(null); } }, [taskView]);
  useEffect(() => {
    if (initialized.current && !loading && (runId || historyId) && !hasTaskContext) clearTaskSelection();
    // A task can disappear through another page's deletion or a fresh list read.
    // Clear its context without selecting another paper or resetting the draft.
  }, [hasTaskContext, runId, historyId, loading]);
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
    if (cause instanceof WorkbenchError && cause.code === "invalid_task_title") return t("t1.invalidTaskTitle");
    if (cause instanceof WorkbenchError && cause.code === "invalid_original_filename") return t("t1.invalidPdf");
    if (cause instanceof WorkbenchError && cause.code === "submission_payload_conflict") return t("t1.submissionConflict");
    if (cause instanceof WorkbenchError && cause.code === "submission_result_deleted") return t("t1.submissionDeleted");
    if (cause instanceof WorkbenchError && cause.code === "submission_busy") return t("t1.submissionBusy");
    if (cause instanceof WorkbenchError && cause.code.split(",").includes("catalog_version_mismatch")) return t("t1.scopeCatalogChanged");
    if (cause instanceof WorkbenchError && cause.code.startsWith("scope_catalog_")) return t("t1.scopeCatalogInvalid");
    if (cause instanceof WorkbenchError && cause.code === "feature_scope_removed") return t("t1.featureScopeRemoved");
    if (cause instanceof WorkbenchError && ["batch_scope_frozen", "batch_model_frozen", "batch_task_title_frozen"].includes(cause.code)) return t("t1.submissionConflict");
    if (cause instanceof WorkbenchError && ["invalid_model_profile", "model_profile_limit"].includes(cause.code)) return t("t1.invalidModelProfile");
    if (cause instanceof WorkbenchError && ["invalid_model_profile_id", "model_profile_not_found"].includes(cause.code)) return t("t1.missingSavedModel");
    if (cause instanceof WorkbenchError && ["workbench_run_not_found", "s4_run_not_found"].includes(cause.code)) return t("t1.selectedRunUnavailable");
    if (cause instanceof WorkbenchError && cause.code.includes("source_glyph_check_missing")) return t("t1.sourceGlyphLegacy");
    if (cause instanceof WorkbenchError && cause.code.includes("source_glyph_fidelity_unverified")) return t("t1.sourceGlyphUnreliable");
    if (cause instanceof WorkbenchError && cause.code === "restore_requires_identical_pdf") return t("t1.restoreMismatch");
    if (cause instanceof WorkbenchError && ["paper_has_active_runs", "cancel_active_runs_before_deleting_paper"].includes(cause.code)) return t("t1.activePaperDelete");
    if (cause instanceof WorkbenchError && cause.code === "paper_deletion_in_progress") return t("t1.paperDeleting");
    if (cause instanceof WorkbenchError && cause.code === "paper_busy_before_deleting_run") return t("t1.runDeleteBusy");
    if (cause instanceof WorkbenchError && cause.code === "batch_task_deletion_required") return t("t1.batchTaskDeletionRequired");
    if (cause instanceof WorkbenchError && cause.code.startsWith("source_integrity_blocked")) return t("t1.sourceProblem");
    if (cause instanceof WorkbenchError) return cause.status === 502 ? t("t1.backendUnavailable") : cause.status === 404 ? t("t1.notFound") : cause.status === 409 ? t("t1.conflict") : cause.code;
    if (cause instanceof TypeError) return t("t1.connectionInterrupted");
    return cause instanceof Error ? cause.message : t("t1.requestFailed");
  }
  const currentErrorText = useRef(errorText);
  useEffect(() => { currentErrorText.current = errorText; });
  function openTab(id: string) {
    if ((id === "records" || id === "figures") && !hasTaskContext) return;
    setTabIds(current => current.includes(id) ? current : [...current, id]); setActiveTab(id);
    if (mobile && (id === "newTask" || id === "tasks")) showTaskNavigation(false);
  }
  function newTask() { setShowSource(false); setActionError(""); openTab("newTask"); }
  function showTaskNavigation(open: boolean) { navFocusTarget.current = open; setShowSidebar(open); }
  function chooseModel(id: string) { setModelProfileId(id); try { localStorage.setItem("t1:extraction-model-profile", id); } catch { /* In-memory selection still works. */ } }
  function selectRun(run: WorkbenchRun) {
    if (deletedRuns.current.has(run.run_id)) return;
    setRestoreFile(null); setPaperId(run.document_id); setRunId(run.run_id); setHistoryId(""); setRecordId(""); setPage(1); setActionError("");
    setTabIds(current => current.includes("records") ? current : [...current, "records"]); setActiveTab("records"); if (mobile) showTaskNavigation(false);
  }
  function clearTaskSelection() {
    setPaperId(""); setRunId(null); setHistoryId(""); setRecordId(""); setRunDetail(null); setDetail(null); setPage(1);
    setShowSource(false); setShowNotes(false); setEditor(null); setRestoreFile(null); setDetailError(""); setActionError("");
    const globalTab = selectionRef.current.activeTab === "tasks" ? "tasks" : "newTask";
    selectionRef.current = { paperId: "", runId: null, historyId: "", activeTab: globalTab };
    setTabIds(current => [...new Set([...current.filter(id => id === "newTask" || id === "tasks"), globalTab])]); setActiveTab(globalTab);
  }
  const visibleRun = (run: WorkbenchRun) => !deletedRuns.current.has(run.run_id) && !(run.submission?.kind === "batch" && deletedBatches.current.has(run.submission.batch_id));
  const cleanPaper = (paper: WorkbenchPaper) => ({ ...paper, output_ids: paper.output_ids.filter(id => !deletedRuns.current.has(id)) });
  const cleanPaperDetail = (value: WorkbenchPaperDetail) => ({ ...value, paper: cleanPaper(value.paper), outputs: value.outputs.filter(output => !deletedRuns.current.has(output.id)) });
  function openRunMenu(event: React.MouseEvent<HTMLButtonElement>, run: WorkbenchRun) {
    setMenu(null); const opener = event.currentTarget, rect = opener.getBoundingClientRect();
    setTaskMenu({ runId: run.run_id, paperId: run.document_id, anchor: { kind: "rect", rect, align: "start" }, opener });
  }
  function requestRunDeletion(run: WorkbenchRun, opener?: HTMLButtonElement) {
    const group = taskGroups.find(group => group.id === submittedTaskId(run));
    setDeleteError(""); setDeleteTarget({ runId: run.run_id, paperId: run.document_id, title: run.submission?.kind === "batch" ? group?.taskTitle ?? t("t1.taskBatch") : taskDisplayTitle(run, papers.find(paper => paper.id === run.document_id)), createdAt: run.created_at, modelId: run.model_id, opener,
      ...(run.submission?.kind === "batch" ? { batchId: run.submission.batch_id, members: (group?.runs ?? [run]).map(member => ({ runId: member.run_id, paperId: member.document_id, filename: originalRunFilename(member, papers.find(paper => paper.id === member.document_id)) })) } : {}) });
  }
  function sourcePage(value: number) { if (!taskView || !pdfUrl) return; setPage(value); setShowSource(true); if (window.matchMedia("(max-width: 900px)").matches) window.open(`${pdfUrl}#page=${value}`, "_blank", "noopener,noreferrer"); }
  const refresh = () => setRevision(value => value + 1);
  const reloadCurrent = async () => { if (batchId) await batchResults.reload(operationRunId ?? undefined); else await refreshRunRef.current?.load(); };

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
          const reads = await Promise.allSettled([selected.paperId ? paperRead?.load() : undefined, selected.runId ? runRead?.load() : undefined, refreshBatchRef.current?.()]);
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
      flight = Promise.all([api<WorkbenchCapabilities>("workbench/capabilities", { signal: controller.signal }), api<{ papers: WorkbenchPaper[] }>("workbench/papers", { signal: controller.signal }), api<{ runs: WorkbenchRun[] }>("workbench/runs", { signal: controller.signal }), api<WorkbenchScopeCatalog>("workbench/catalog", { signal: controller.signal }).then(value => ({ value, error: null })).catch(error => ({ value: null, error })), api<WorkbenchModels>("workbench/models", { signal: controller.signal })])
      .then(([caps, listed, tasks, rawChoices, availableModels]) => {
        if (controller.signal.aborted) return;
        const choices: ScopeCatalog | null = rawChoices.value ? { ...rawChoices.value, catalog: rawChoices.value } : null;
        setCapabilities(caps); setPapers(listed.papers.map(cleanPaper)); if (version === runsReadVersion.current) setRuns(tasks.runs.filter(visibleRun)); setCatalog(choices); if (choices) setScope(current => refreshDraftScope(current, choices)); setError(rawChoices.error ? currentErrorText.current(rawChoices.error) : "");
        setModels(availableModels);
        if (!modelInitialized.current) {
          let saved: string | null = null; try { saved = localStorage.getItem("t1:extraction-model-profile"); } catch { /* A fresh selection uses the configured default. */ }
          setModelProfileId(saved ?? availableModels.default_profile_id); modelInitialized.current = true;
        }
        if (!initialized.current) {
          const selected = initialWorkbenchSelection(new URLSearchParams(window.location.search), listed.papers, tasks.runs);
          setPaperId(selected.paperId); setRunId(selected.runId); setHistoryId(selected.historyId); setRecordId(selected.recordId); setActiveTab(selected.activeTab);
          setTabIds([selected.activeTab]);
          // Even a normalized empty selection may equal the initial React
          // values, so its URL effect would not run after the first list read.
          window.history.replaceState(null, "", `/?${workbenchSelectionParams(selected)}`);
          initialized.current = true;
        } else if (version === runsReadVersion.current && (selectionRef.current.runId || selectionRef.current.historyId)
          && !hasWorkbenchTaskContext(selectionRef.current, listed.papers, tasks.runs.filter(visibleRun))) {
          clearTaskSelection();
        }
        // Keep the saved task lists usable, while reporting a partial refresh as a failure.
        if (rawChoices.error) throw rawChoices.error;
      }).catch(cause => { if (!controller.signal.aborted && !refreshingRef.current) setError(currentErrorText.current(cause)); throw cause; }).finally(() => { flight = null; if (!controller.signal.aborted) setLoading(false); });
      return flight;
    }
    refreshWorkspaceRef.current = load; void load().catch(() => {});
    return () => { controller.abort(); if (refreshWorkspaceRef.current === load) refreshWorkspaceRef.current = null; };
    // Locale changes do not restart task I/O.
  }, [revision]);

  useEffect(() => {
    if (!paperId) { refreshPaperRef.current = null; return; }
    const controller = new AbortController(); let flight: Promise<void> | null = null; setDetailError("");
    function load() {
      if (flight) return flight;
      flight = api<WorkbenchPaperDetail>(`workbench/papers/${encodeURIComponent(paperId)}`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      const cleaned = cleanPaperDetail(value); setDetail(cleaned);
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
          const mutationVersion = runMutationVersions.current.get(runId!) ?? 0;
          try {
            const value = await api<RunDetail>(`workbench/runs/${encodeURIComponent(runId!)}`, { signal: controller.signal });
            if (value.run.run_id !== runId || value.output.id !== runId || value.run.document_id !== value.paper.id || value.output.records.some(record => record.run_id !== runId)) throw new Error(t("t1.selectedRunUnavailable"));
            if (!controller.signal.aborted && selectionRef.current.runId === runId && !deletedRuns.current.has(runId!) && mutationVersion === (runMutationVersions.current.get(runId!) ?? 0)) { setRunDetail(value); setRunObservedAt({ id: runId!, at: Date.now() }); setDetailError(""); setPapers(current => current.map(paper => paper.id === value.paper.id ? cleanPaper(value.paper) : paper)); }
          } catch (cause) {
            if (!controller.signal.aborted && selectionRef.current.runId === runId && cause instanceof WorkbenchError && cause.code === "workbench_run_not_found") { clearTaskSelection(); return; }
            if (!controller.signal.aborted && !refreshingRef.current && !cancellingRef.current.has(runId!) && !deletedRuns.current.has(runId!)) setDetailError(errorText(cause)); throw cause;
          }
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
    const params = workbenchSelectionParams({ paperId: taskView ? paperId : "", runId: taskView ? runId : null, historyId: taskView ? historyId : "", recordId: taskView ? recordId : "", activeTab });
    window.history.replaceState(null, "", `/?${params}`);
  }, [paperId, runId, historyId, recordId, activeTab, taskView]);
  const lastEvent = events.at(-1)?.seq ?? 0;
  useEffect(() => {
    if (!lastEvent) return;
    const timer = window.setTimeout(() => { if (!refreshingRef.current) void (refreshBatchRef.current?.() ?? refreshRunRef.current?.load())?.catch(() => {}); }, 350);
    return () => clearTimeout(timer);
  }, [lastEvent]);
  useEffect(() => {
    const controller = new AbortController(); let busy = false;
    const timer = window.setInterval(async () => {
      if (busy || refreshingRef.current || document.visibilityState !== "visible") return;
      busy = true; const version = ++runsReadVersion.current;
      try { const listed = await api<{ runs: WorkbenchRun[] }>("workbench/runs", { signal: controller.signal }); if (!controller.signal.aborted && version === runsReadVersion.current) setRuns(listed.runs.filter(visibleRun)); }
      catch { /* The selected run has its own visible connection and read errors. */ }
      finally { busy = false; }
    }, 10000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);


  async function cancelRun(id: string) {
    const target = runsRef.current.find(run => run.run_id === id), batch = target?.submission?.kind === "batch" ? target.submission.batch_id : undefined;
    const members = batch ? runsRef.current.filter(run => run.submission?.kind === "batch" && run.submission.batch_id === batch) : target ? [target] : [];
    if (!members.length || members.some(run => cancellingRef.current.has(run.run_id))) return;
    for (const run of members) cancellingRef.current.add(run.run_id);
    setCancelling(new Set(cancellingRef.current));
    const label = `${batch ? target!.task_title ?? t("t1.taskBatch") : taskDisplayTitle(target!, papers.find(item => item.id === target!.document_id))} · #${(batch ?? id).slice(-8)}`;
    setTaskNotice({ id, busy: true, failed: false, text: `${t("t1.cancelling")} · ${label}` });
    try {
      const response = await api<{ run?: WorkbenchRun; runs?: WorkbenchRun[] }>(batch ? `workbench/batches/${encodeURIComponent(batch)}/cancel` : `workbench/runs/${encodeURIComponent(id)}/cancel`, jsonBody("POST", {}));
      const changed = response.runs ?? (response.run ? [response.run] : []);
      if (!changed.length || changed.some(run => !members.some(member => member.run_id === run.run_id))) throw new Error("task_cancellation_unconfirmed");
      ++runsReadVersion.current;
      for (const run of changed) runMutationVersions.current.set(run.run_id, (runMutationVersions.current.get(run.run_id) ?? 0) + 1);
      setRuns(current => current.map(run => changed.find(item => item.run_id === run.run_id) ?? run));
      setRunDetail(current => current && changed.some(run => run.run_id === current.run.run_id) ? { ...current, run: changed.find(run => run.run_id === current.run.run_id)! } : current);
      const version = ++runsReadVersion.current;
      const reads = await Promise.allSettled([
        api<{ runs: WorkbenchRun[] }>("workbench/runs").then(listed => { if (version === runsReadVersion.current) setRuns(listed.runs.filter(visibleRun)); }),
        batch && batch === batchId ? batchResults.reload() : selectionRef.current.runId === id ? refreshRunRef.current?.load() ?? Promise.resolve() : Promise.resolve(),
      ]);
      const results = changed.map(run => cancellationResult(run.state));
      const key = results.includes("cancelUnconfirmed") ? "cancelUnconfirmed" : results.includes("cancelFinalizing") ? "cancelFinalizing" : results.includes("cancelDone") ? "cancelDone" : "cancelEnded", failed = key === "cancelUnconfirmed";
      const suffix = reads.some(read => read.status === "rejected") ? ` ${t("t1.cancelRefreshFailed")}` : "";
      setTaskNotice(current => current?.id === id ? { id, busy: false, failed, text: `${t(`t1.${key}`)} · ${label}${suffix}` } : current);
    } catch (cause) {
      setTaskNotice(current => current?.id === id ? { id, busy: false, failed: true, text: `${t("t1.cancelFailed", { reason: errorText(cause) })} · ${label}` } : current);
    } finally { for (const run of members) cancellingRef.current.delete(run.run_id); setCancelling(new Set(cancellingRef.current)); }
  }
  async function downloadExport(kind: WorkbenchExportKind) {
    if (!runId) return;
    setDownload(kind); setExportError("");
    try {
      const response = await request(batchId ? `workbench/batches/${encodeURIComponent(batchId)}/exports/retained_package` : `workbench/runs/${encodeURIComponent(runId)}/exports/${kind}`), blob = await response.blob();
      const url = URL.createObjectURL(blob), anchor = document.createElement("a"); anchor.href = url;
      anchor.download = batchId ? `batch-${batchId}-retained.tar.gz` : `${paperId}-${runId}-${kind}.${kind.endsWith("package") ? "tar.gz" : kind.endsWith("csv") ? "csv" : "jsonl"}`;
      anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setExportError(errorText(cause)); } finally { setDownload(""); }
  }
  async function restoreOriginal() {
    if (!restoreFile || restoreFile.size > 50 * 1024 * 1024) return;
    setRestoreBusy(true); setActionError("");
    try { await api(`workbench/papers/${encodeURIComponent(paper?.id ?? paperId)}/pdf`, { method: "PUT", headers: { "content-type": "application/pdf" }, body: restoreFile }); setRestoreFile(null); await reloadCurrent(); }
    catch (cause) { setActionError(errorText(cause)); } finally { setRestoreBusy(false); }
  }
  function applyRunDeletion(target: RunDeleteTarget) {
      const ids = new Set([target.runId, ...(target.members?.map(member => member.runId) ?? []), ...runsRef.current.filter(run => target.batchId && run.submission?.kind === "batch" && run.submission.batch_id === target.batchId).map(run => run.run_id)]);
      if (target.batchId) deletedBatches.current.add(target.batchId);
      for (const id of ids) { deletedRuns.current.add(id); runMutationVersions.current.set(id, (runMutationVersions.current.get(id) ?? 0) + 1); }
      ++runsReadVersion.current;
      const remaining = runsRef.current.filter(visibleRun);
      setRuns(remaining); setPapers(current => current.map(cleanPaper)); setDetail(current => current ? cleanPaperDetail(current) : current);
      setRunDetail(current => current && ids.has(current.run.run_id) ? null : current);
      const selected = selectionRef.current;
      if (selected.runId && ids.has(selected.runId) || selected.historyId && ids.has(selected.historyId)) {
        clearTaskSelection();
      }
  }
  async function deleteRun(target: RunDeleteTarget) {
    if (deletingRuns.current.has(target.runId)) return;
    deletingRuns.current.add(target.runId); setDeleteBusy(true); setDeleteError("");
    try {
      await api(target.batchId ? `workbench/batches/${encodeURIComponent(target.batchId)}` : `workbench/runs/${encodeURIComponent(target.runId)}`, jsonBody("DELETE", {}));
      applyRunDeletion(target);
      setCleanupTarget(current => current?.runId === target.runId ? null : current);
      setDeleteTarget(current => current?.runId === target.runId ? null : current);
      setRefreshMessage({ failed: false, text: t("t1.runDeleted", { title: `${target.title} · #${(target.batchId ?? target.runId).slice(-8)}` }) });
      refresh();
    } catch (cause) {
      if (cause instanceof WorkbenchError && ["run_deleted_cleanup_pending", "batch_deleted_cleanup_pending"].includes(cause.code)) {
        applyRunDeletion(target); setCleanupTarget(target); setDeleteError(t("t1.runCleanupPending")); refresh();
      } else setDeleteError(t("t1.runDeleteFailed", { reason: errorText(cause) }));
    }
    finally { deletingRuns.current.delete(target.runId); setDeleteBusy(false); }
  }
  async function refreshStoragePapers(removedPaperIds: string[]) {
    if (removedPaperIds.length) setStoragePaperAvailability({ removedPaperIds });
    const listed = await api<{ papers: WorkbenchPaper[] }>("workbench/papers");
    setPapers(listed.papers.map(cleanPaper));
    // Only a successful read can establish that an unsubmitted draft's source
    // is missing after an unconfirmed cleanup response.
    setStoragePaperAvailability({ removedPaperIds, presentPaperIds: listed.papers.map(paper => paper.id) });
  }
  function sourceIssueText(issue: string) {
    return t(issue.startsWith("pdf_") ? issue.includes("missing") ? "t1.pdfMissing" : "t1.pdfChanged" : issue.startsWith("ir_") ? "t1.irProblem" : "t1.bindingProblem");
  }
  const state = batchId ? displayedRun?.state : currentRun?.run.state ?? selectedRun?.state ?? output?.state;
  const taskCoverage = batchId ? displayedRun : output?.coverage ?? selectedRun;
  const rawPresentation = runPresentation(state, taskCoverage, displayedRun?.result_ready, displayedRun?.task_completion);
  const presentation = { ...rawPresentation, statusKey: batchId && state && canCancelRun({ state }) ? "batchProcessing" : rawPresentation.statusKey };
  function runLabel(run: WorkbenchRun) {
    if (run.run_id.startsWith("batch:") && canCancelRun(run)) return t("t1.batchProcessing");
    return t(`t1.${runPresentation(run.state, run).statusKey}`);
  }
  const selectedEditorRecord = editor?.record ? records.find(item => item.id === editor.record && item.run_id === editor.run) ?? null : null;
  const workspaceTitle = activeTab === "newTask" || activeTab === "tasks" ? t(`t1.${activeTab}`) : taskView ? displayedRun ? batchId ? selectedGroup?.taskTitle ?? t("t1.taskBatch") : taskDisplayTitle(displayedRun, paper) : paper?.title ?? t("t1.historical") : t("t1.title");
  const sourceActions = pdfUrl && <><button className="t1-button t1-source-toggle" aria-pressed={showSource} onClick={() => setShowSource(value => !value)}><EyeIcon size={15} />{t(showSource ? "t1.hideOriginal" : "t1.showOriginal")}</button><a className="t1-button t1-mobile-source" href={`${pdfUrl}#page=${page}`} target="_blank" rel="noreferrer"><OpenInNewTabIcon size={14} />{t("t1.openOriginal")}</a></>;

  return <div className="t1-workbench" ref={sidebar.panelRef} data-source-open={showSource && Boolean(pdfUrl)}>
    <header className="t1-topbar"><div className="t1-brand"><span>T1</span><strong>{t("t1.title")}</strong></div>
      <div className="t1-top-actions"><select aria-label={t("t1.language")} value={locale} onChange={e => setLocale(e.target.value as typeof locale)}>{supportedLocales.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select><button onClick={() => void refreshWorkspace()} disabled={loading || refreshing} aria-busy={refreshing} aria-label={t(refreshing ? "t1.refreshing" : "t1.refresh")} title={t(refreshing ? "t1.refreshing" : "t1.refresh")}><RefreshIcon size={16} /></button><button aria-label={t("t1.theme")} title={t("t1.theme")} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ kind: "rect", rect, align: "end" }); }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M20.8 13.2A9 9 0 0 1 10.8 3.1 9 9 0 1 0 20.8 13.2Z" /></svg></button></div>
    </header>
    <span className="t1-sr-only" role="status" aria-live="polite">{refreshing ? t("t1.refreshing") : ""}</span>
    <GlobalToasts dismissLabel={t("t1.close")} items={[
      ...(refreshMessage ? [{ id: "refresh", notice: refreshMessage, onDismiss: () => setRefreshMessage(null), action: refreshMessage.failed ? <button className="t1-button" onClick={() => void refreshWorkspace()}>{t("t1.retry")}</button> : undefined }] : []),
      ...(taskNotice ? [{ id: "task", notice: taskNotice, onDismiss: () => setTaskNotice(null), className: "t1-task-toast", action: taskNotice.failed ? <button className="t1-button" onClick={() => void cancelRun(taskNotice.id)}>{t("t1.retry")}</button> : undefined }] : []),
    ]} />
    <div className="t1-body" ref={source.panelRef}>
      <div className="t1-navigation" data-expanded={showSidebar} id="t1-task-navigation">
      {showSidebar ? <aside className="t1-sidebar" aria-label={t("t1.submittedTasks")} onKeyDown={event => { if (mobile && event.key === "Escape") { event.preventDefault(); showTaskNavigation(false); } }}><div className="t1-sidebar-heading"><strong>{t("t1.submittedTasks")}</strong><span>{taskGroups.length}</span><button type="button" ref={collapseNavRef} className="t1-nav-toggle t1-sidebar-collapse" aria-label={t("t1.collapseTaskNav")} title={t("t1.collapseTaskNav")} aria-controls="t1-task-navigation" aria-expanded={true} onClick={() => showTaskNavigation(false)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16m7-11-3 3 3 3" /></svg></button></div>
        <button className="t1-new-task" onClick={newTask}><PlusIcon size={16} />{t("t1.newTask")}</button>
        <div className="t1-paper-list-region" aria-busy={refreshing}><SubmissionRunList variant="sidebar" runs={runs} papers={papers} selectedId={taskView ? runId ?? historyId : null} menuRunId={taskMenu?.runId} onSelect={selectRun} onMenu={openRunMenu} statusLabel={runLabel} />{refreshing && <div className="t1-refresh-overlay" aria-hidden="true" />}</div>
        <div className="t1-sidebar-bottom"><button onClick={() => openTab("tasks")}><MessageIcon size={15} />{t("t1.tasks")}</button><button type="button" className="t1-storage-entry" aria-haspopup="dialog" aria-expanded={showStorage} onClick={() => setShowStorage(true)}><StorageIcon />{t("t1.storageManagement")}</button><DetailDisclosure title={t("t1.aboutWorkbench")}><p>Pi Web 0.15.0 · T1 Pi SDK 1.4.0</p></DetailDisclosure></div>
        <SidebarToast toast={toast} onDismiss={() => setToast(null)} dismissLabel={t("t1.close")} /></aside> : <nav className="t1-nav-rail" aria-label={t("t1.submittedTasks")}><button type="button" ref={expandNavRef} className="t1-nav-toggle" aria-label={t("t1.expandTaskNav")} title={t("t1.expandTaskNav")} aria-controls="t1-task-navigation" aria-expanded={false} onClick={() => showTaskNavigation(true)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16m4-11 3 3-3 3" /></svg><span aria-hidden="true">{t("t1.task")}</span></button></nav>}
      </div>
      {showSidebar && <div className="t1-resize" {...sidebar.separatorProps} />}
      <main className="t1-main"><div className="t1-workspace-bar"><span title={workspaceTitle}>{workspaceTitle}</span></div>
        <TabBar tabs={tabs} activeTabId={activeTab} onSelectTab={setActiveTab} onCloseTab={id => { const next = tabIds.filter(tab => tab !== id); setTabIds(next); if (activeTab === id) setActiveTab(next[0] ?? ""); }} onReorderTab={(from, to, after) => setTabIds(current => movePanelTab(current, from, to, after))} />
        <div className="t1-content-region" aria-busy={refreshing}><div className="t1-content" data-view={activeTab} data-source-blocked={sourceBlocked}>
          {loading && <p className="t1-status" role="status">{t("t1.loading")}</p>}
          {error && <div className="t1-alert" role="alert">{error}<button onClick={refresh}>{t("t1.retry")}</button></div>}
          {cleanupTarget && !deleteTarget && <div className="t1-alert t1-cleanup-recovery" role="alert"><span>{t("t1.runCleanupPending")} · {cleanupTarget.title}</span><button className="t1-button" onClick={() => { setDeleteTarget(cleanupTarget); setDeleteError(t("t1.runCleanupPending")); }}>{t("t1.retryCleanup")}</button></div>}
          {taskView && batchId && Object.entries(batchResults.errors).map(([id, text]) => <div className="t1-alert" role="alert" key={id}>{t("t1.batchMemberReadFailed", { name: selectedGroup?.runs.find(run => run.run_id === id)?.original_filename ?? id })} · {text}<button className="t1-button" onClick={() => void batchResults.reload(id)}>{t("t1.retry")}</button></div>)}
          {actionError && taskView && <div className="t1-alert" role="alert">{actionError}</div>}
          {detailError && taskView && <div className="t1-alert" role="alert">{detailError}<button onClick={refresh}>{t("t1.retry")}</button></div>}
          {sourceBlocked && taskView && <div className="t1-alert" role="alert">{t("t1.sourceProblem")}{[...new Set(sourceIssues.map(sourceIssueText))].map((issue, i) => <p key={i}>{issue}</p>)}<DetailDisclosure key={operationRunId} title={t("t1.sourceVersion")}>{sourceIssues.join(" · ")}</DetailDisclosure></div>}
          {sourceBlocked && taskView && paper && <section className="t1-source-recovery"><p>{t("t1.restoreHelp")}</p><label className="t1-field">{t("t1.selectRestorePdf")}<input type="file" accept="application/pdf,.pdf" aria-label={t("t1.selectRestorePdf")} onChange={e => setRestoreFile(e.target.files?.[0] ?? null)} /></label><button className="t1-primary" disabled={!restoreFile || restoreBusy} onClick={() => void restoreOriginal()}>{t("t1.restorePdf")}</button></section>}
          {capabilities?.controlled_fixture && <p className="t1-fixture-banner">{t("t1.fixture")}</p>}
          {!activeTab && <div className="t1-empty">{(hasTaskContext ? ["newTask", "records", "figures", "tasks"] : ["newTask", "tasks"]).map(id => <button key={id} onClick={() => openTab(id)}>{t(`t1.${id}`)}</button>)}</div>}
          <section className="t1-new-task-panel" hidden={activeTab !== "newTask"}><div className="t1-heading"><h1>{t("t1.newTask")}</h1><span className="t1-badge">B0</span></div>
            <BatchSubmission key={submissionRevision} scope={scope} catalog={catalog} onScopeChange={setScope} canUpload={Boolean(capabilities?.paper_upload)} canStart={Boolean(capabilities?.extraction_start)} runs={runs} modelProfile={selectedModel} modelRequired={Boolean(capabilities?.model_selection)} storagePaperAvailability={storagePaperAvailability} errorText={errorText}
              modelSelection={(capabilities?.model_selection && models || modelRuntime) ? <section className="t1-task-card t1-model-configuration" aria-label={t("t1.modelConfiguration")}>
                <h2 className="t1-task-card-title">{t("t1.modelConfiguration")}</h2>
                {capabilities?.model_selection && models && <ModelSelection models={models} value={modelProfileId} onChange={chooseModel} onModelsChange={setModels} errorText={errorText} />}
                <ModelRuntimeNotice runtime={modelRuntime} maxConcurrent={capabilities?.max_concurrent_runs} showModel={!capabilities?.model_selection} />
              </section> : undefined}
              onUploaded={paper => { setPapers(current => [paper, ...current.filter(item => item.id !== paper.id)]); }}
              onStarted={run => { ++runsReadVersion.current; setRuns(current => [run, ...current.filter(item => item.run_id !== run.run_id)]); }}
              onSingleStarted={run => { setSubmissionRevision(value => value + 1); setTaskNotice({ id: run.run_id, busy: false, failed: false, text: t("t1.taskCreated") }); selectRun(run); }} onBatchStarted={members => { setSubmissionRevision(value => value + 1); setTaskNotice({ id: members[0]!.run_id, busy: false, failed: false, text: t("t1.batchTaskCreated", { count: members.length }) }); ++runsReadVersion.current; setRuns(current => [...members, ...current.filter(run => !members.some(member => member.run_id === run.run_id))]); selectRun(members[0]!); }} onView={selectRun} />
            {!capabilities?.extraction_start && <p className="t1-notice">{t("t1.extractionUnavailable")}{capabilities?.extraction_unavailable_reason && capabilities.extraction_unavailable_reason !== "server_model_not_enabled" && <small>{capabilities.extraction_unavailable_reason}</small>}</p>}
          </section>
          {activeTab === "records" && <>
            <div className="t1-heading t1-results-heading"><h1>{t("t1.extractionResults")}</h1>
              <div className="t1-output-toolbar"><details className="t1-task-picker"><summary>{t("t1.task")} {batchId && <span className="t1-badge">{t("t1.taskBatch")}</span>}</summary><label>{t("t1.task")}<select aria-label={t("t1.task")} value={selectedGroup?.id ?? (runId ? `run:${runId}` : `history:${historyId}`)} onChange={e => { const group = taskGroups.find(group => group.id === e.target.value); if (group) selectRun(group.runs[0]!); else { setRunId(null); setHistoryId(e.target.value.slice(8)); setRecordId(""); } }}>
                {!taskGroups.length && !currentPaper?.outputs.length && <option value="history:">{t("t1.noTasks")}</option>}{taskGroups.map(group => <option key={group.id} value={group.id}>{group.kind === "batch" ? group.taskTitle ?? t("t1.taskBatch") : taskDisplayTitle(group.runs[0]!, papers.find(paper => paper.id === group.runs[0]!.document_id))} · {group.kind === "batch" ? t("t1.batchPaperCount", { count: group.runs.length }) : t("t1.taskSingle")} · #{group.id.slice(-8)}</option>)}{currentPaper?.outputs.filter(item => item.origin === "historical_compatibility_replay" && !paperRuns.some(run => run.run_id === item.id)).map(item => <option key={item.id} value={`history:${item.id}`}>{t("t1.historical")} · {item.strategy} · {item.records.length}</option>)}</select></label></details>
                {state && <div className="t1-task-progress" role="status" data-state={state} data-status={presentation.statusKey}><button className="t1-status-button" onClick={() => setShowNotes(true)}><span className="t1-status-dot" />{t(`t1.${presentation.statusKey}`)}</button>{runId && (batchId ? selectedGroup?.runs.some(canCancelRun) : canCancelRun({ state })) && <button className="t1-button" disabled={cancelling.has(runId)} aria-busy={cancelling.has(runId)} onClick={() => void cancelRun(runId)}>{t(cancelling.has(runId) ? "t1.cancelling" : "t1.cancel")}</button>}</div>}
                {presentation.sourceLimited && <button className="t1-source-limits-chip" onClick={() => setShowNotes(true)}>{t("t1.sourceLimitsBadge")}</button>}
              </div>
              <div className="t1-results-actions">{hasTaskContext && <button className="t1-button" onClick={() => openTab("figures")}>{t("t1.figures")}</button>}{sourceActions}<button className="t1-button t1-notes-toggle" aria-haspopup="dialog" aria-expanded={showNotes} onClick={() => setShowNotes(true)}><MessageIcon size={14} />{t("t1.notes")}</button>
                {runId && currentRun && <details className="t1-exports"><summary><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5" /></svg>{t("t1.exportTitle")}<ChevronIcon size={12} /></summary><div className="t1-export-options" aria-label={t("t1.exportFormat")}>{(batchId ? ["retained_package" as const] : exportKinds).map(kind => <button key={kind} disabled={Boolean(download) || (batchId ? batchResults.loading || Object.keys(batchResults.errors).length > 0 : sourceBlocked) || !capabilities?.retained_export || keptCount === 0} onClick={() => void downloadExport(kind)}>{t(`t1.${kind}`)}</button>)}</div></details>}
              </div>
            </div>
            {state && !batchId && <RunProgress run={displayedRun} state={state} coverage={taskCoverage} events={progressEvents} connection={connection} observedAt={runObservedAt?.id === displayedRun?.run_id ? runObservedAt?.at : undefined} onDetails={() => setShowNotes(true)} />}
            {batchId && selectedGroup && <BatchProgress batchId={batchId} runs={selectedGroup.runs} papers={papers} runLabel={runLabel} />}
            {missingHistoricalSource && <p className="t1-alert" role="status">{t("t1.historicalSourceUnavailable")}</p>}
            {exportError && <div className="t1-alert t1-export-error" role="alert">{exportError}<button className="t1-button" onClick={() => { setExportError(""); setShowNotes(true); }}>{t("t1.viewDetails")}</button></div>}
            {download && <span className="t1-sr-only" role="status">{t("t1.downloading")}</span>}
            <section className="t1-results-panel" aria-label={t("t1.extractionResults")}>
              <div className="t1-record-nav"><div className="t1-retention-views" aria-label={t("t1.retentionViews")}>{["kept", "excluded"].map(view => <button key={view} data-retention-view={view} aria-pressed={retentionView === view} onClick={() => { setRetentionView(view); setRecordId(""); }}>{t(view === "kept" ? "t1.keptResults" : "t1.excluded")}<span data-retention-count={view}>{view === "kept" ? keptCount : excludedCount}</span></button>)}</div>
                <label className="t1-record-search"><SearchIcon size={14} /><input type="search" aria-label={t("t1.findRecord")} placeholder={t("t1.findRecord")} value={recordQuery} onChange={e => setRecordQuery(e.target.value)} /></label>
                <label className="t1-role-filter"><span className="t1-sr-only">{t("t1.candidateRole")}</span><select aria-label={t("t1.candidateRole")} value={recordRole} onChange={e => { setRecordRole(e.target.value); setRecordId(""); }}><option value="all">{t("t1.allCandidates")}</option><option value="primary_candidate">{t("t1.primaryDescriptions")}</option><option value="background_suggestion">{t("t1.backgroundSuggestions")}</option></select></label>
              </div>
              {!records.length ? <div className="t1-empty"><p>{t(loadingRun ? "t1.loadingSelectedRun" : unavailableHistory ? "t1.selectedRunUnavailable" : output ? "t1.noRecords" : "t1.noRun")}</p><button onClick={() => openTab("newTask")}>{t("t1.newTask")}</button></div> : <>
                <div className="t1-record-step"><label className="t1-record-selector"><span className="t1-sr-only">{t("t1.record")}</span><select aria-label={t("t1.record")} value={record ? resultRecordKey(record) : ""} onChange={e => setRecordId(e.target.value)}>{!visibleRecords.length && <option value="">{t("t1.noMatchingRecords")}</option>}{visibleRecords.map(item => <option key={resultRecordKey(item)} value={resultRecordKey(item)}>{records.indexOf(item) + 1} · {item.fragments[0]?.exact_quote.slice(0, 82)}</option>)}</select></label><span className="t1-record-position">{recordPosition + 1} / {visibleRecords.length}</span><button aria-label={t("t1.previousRecord")} title={t("t1.previousRecord")} disabled={recordPosition <= 0} onClick={() => setRecordId(resultRecordKey(visibleRecords[recordPosition - 1]))}><ChevronIcon size={15} className="t1-chevron-back" /></button><button aria-label={t("t1.nextRecord")} title={t("t1.nextRecord")} disabled={recordPosition < 0 || recordPosition >= visibleRecords.length - 1} onClick={() => setRecordId(resultRecordKey(visibleRecords[recordPosition + 1]))}><ChevronIcon size={15} /></button></div>
                {!visibleRecords.length ? <p className="t1-empty t1-search-empty" role="status">{t("t1.noMatchingRecords")}</p> : <div className="t1-results-layout"><ResultIndex records={records} visibleRecords={visibleRecords} selectedId={selectedRecordId} sourceLabel={batchId ? item => selectedGroup?.runs.find(run => run.run_id === item.run_id)?.original_filename ?? item.run_id : undefined} onSelect={setRecordId} />
                  {record && <article className="t1-evidence-card" data-record-id={record.id} data-source-run-id={record.run_id} data-source-paper-id={paper?.id} data-record-version={record.version}>
                    <div className="t1-reader-scroll" key={resultRecordKey(record)}>{batchId && <p className="t1-record-provenance">{t("t1.resultPaper")} · {originalRunFilename(recordDetail!.run, recordDetail!.paper)} <small>#{record.run_id.slice(-8)}</small></p>}<div className="t1-record-meta"><span className="t1-record-number">{String(records.indexOf(record) + 1).padStart(2, "0")}</span><h2>{t(record.evidence_role === "background_suggestion" ? "t1.backgroundSource" : "t1.descriptionSource")}</h2>{firstSourcePage && <button className="t1-button t1-locate" onClick={() => sourcePage(firstSourcePage)}><EyeIcon size={14} />{t("t1.locateSource")}</button>}</div>
                      {record.association === "paired" && record.figure_ids.length > 0 && <button className="t1-pair-shortcut" onClick={() => document.getElementById(`t1-record-figures-${record.id}`)?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}>{t("t1.linkedFigureShortcut")}{pairedFigures.length > 0 && ` · ${pairedFigures.map(figure => `Figure ${figure.number ?? "?"}`).join(", ")}`}<ChevronIcon size={12} /></button>}
                      <div className="t1-quote-frame"><Fragments fragments={record.fragments} passages={record.passages} onPage={sourcePage} /></div>
                      {Boolean(record.supporting_table_evidence?.length) && <TableSupport key={resultRecordKey(record)} support={record.supporting_table_evidence!} onPage={sourcePage} />}
                      {!!record.context.length && <DetailDisclosure className="t1-context" key={`${record.run_id}:${record.id}:context`} title={t("t1.context", { count: record.context.length })}>{close => <Fragments fragments={record.context} passages={record.context_passages} onPage={page => { close(); sourcePage(page); }} />}</DetailDisclosure>}
                      <section className="t1-association" id={`t1-record-figures-${record.id}`} data-pairing={record.association} key={`${record.id}:figures`} aria-label={t("t1.correspondingFigures")}>
                        {record.association === "paired" && record.figure_ids.length > 0 ? <><h3>{t("t1.correspondingFigures")}<span>{t("t1.pairedFigureCount", { count: record.figure_ids.length })}</span></h3>{pairedFigures.map(figure => <FigureView key={`${operationRunId}:${figure.id}`} figure={figure} onPage={sourcePage} paired />)}{pairedFigures.length < record.figure_ids.length && <p className="t1-figure-unavailable">{t("t1.linkedFigureUnavailable")}{firstSourcePage && <button className="t1-link" onClick={() => sourcePage(firstSourcePage)}>{t("t1.openOriginal")}</button>}</p>}</> : <p className="t1-pair-status">{t(record.association === "pending" || record.association === "not_checked" ? "t1.figurePairingPending" : "t1.figureNoExplicitReference")}<button className="t1-link" onClick={() => openTab("figures")}>{t("t1.browsePaperFigures")}</button></p>}
                      </section>
                    </div>
                    {editable && capabilities?.persisted_retention && <RecordRetention key={`${operationRunId}:${record.id}:${record.version}:${record.retention?.revision ?? 0}`} runId={operationRunId!} record={record} onNext={recordPosition < visibleRecords.length - 1 ? () => setRecordId(resultRecordKey(visibleRecords[recordPosition + 1])) : undefined} onSaved={async changed => { if (changed) setRecordId(visibleRecords[recordPosition + 1] ? resultRecordKey(visibleRecords[recordPosition + 1]) : visibleRecords[recordPosition - 1] ? resultRecordKey(visibleRecords[recordPosition - 1]) : ""); await reloadCurrent(); }} />}
                  </article>}
                </div>}
              </>}
            </section>
          </>}
          {activeTab === "figures" && <><div className="t1-heading t1-results-heading"><h1>{t("t1.figures")}</h1><div className="t1-results-actions">{hasTaskContext && <button className="t1-button" onClick={() => openTab("records")}>{t("t1.extractionResults")}</button>}{sourceActions}</div></div><p className="t1-lead">{t("t1.independentFigure")}</p>{batchId && recordDetail && <p className="t1-record-provenance">{t("t1.resultPaper")} · {originalRunFilename(recordDetail.run, recordDetail.paper)} <small>#{recordDetail.run.run_id.slice(-8)}</small></p>}{figures.length ? figures.map(figure => <FigureView key={`${operationRunId}:${figure.id}`} figure={figure} onPage={sourcePage} />) : <p className="t1-empty">{t(loadingRun ? "t1.loadingSelectedRun" : missingHistoricalSource ? "t1.historicalSourceUnavailable" : unavailableHistory ? "t1.selectedRunUnavailable" : runId && !currentRun ? "t1.runSourceUnavailable" : "t1.noFigures")}</p>}</>}
          {activeTab === "tasks" && <><div className="t1-heading"><h1>{t("t1.tasks")}</h1><span className="t1-badge">{t("t1.submittedTaskCount", { count: taskGroups.length })}</span></div><p className="t1-lead">{t("t1.groupedTasksHelp")}</p><label className="t1-record-search"><SearchIcon size={14} /><input type="search" aria-label={t("t1.findTask")} placeholder={t("t1.findTask")} value={taskQuery} onChange={event => setTaskQuery(event.target.value)} /></label><SubmissionRunList query={taskQuery} variant="history" runs={runs} papers={papers} selectedId={null} menuRunId={taskMenu?.runId} onSelect={selectRun} onMenu={openRunMenu} statusLabel={runLabel} /></>}

        </div>{refreshing && <div className="t1-refresh-overlay" aria-hidden="true" />}</div>
      </main>
      {taskView && showSource && paper && pdfUrl && <><div className="t1-resize" {...source.separatorProps} /><aside className="t1-source" aria-label={t("t1.originalPdf")}><div className="t1-source-heading"><strong title={paper.filename ?? paper.title}><GenericFileIcon size={15} />{batchId ? paper.filename ?? paper.title : t("t1.originalPdf")}</strong><a href={`${pdfUrl}#page=${page}`} target="_blank" rel="noreferrer">{t("t1.openOriginal")}<OpenInNewTabIcon size={13} /></a></div>{sourceBlocked ? <p className="t1-alert">{t("t1.sourceProblem")}</p> : <PdfSource key={`${paper.id}:${paper.sha256}`} url={pdfUrl} sha256={paper.sha256} page={page} pages={paper.pages} onPage={sourcePage} />}<div className="t1-source-footer"><small>{t("t1.sourceUnchanged")}</small><DetailDisclosure key={paper.id} title={t("t1.sourceVersion")}><code>SHA256 {paper.sha256}</code></DetailDisclosure></div></aside></>}
      {refreshing && <RefreshIndicator label={t("t1.refreshing")} />}
    </div>
    <WorkbenchNotes open={showNotes} title={t(editor ? "t1.editTitle" : "t1.notes")} onClose={() => { setShowNotes(false); setEditor(null); }}>
      {editor && editor.run === operationRunId && !sourceBlocked ? <SourceEditor key={`${editor.run}:${editor.record ?? "new"}`} runId={editor.run} record={selectedEditorRecord} units={units} onPage={value => { sourcePage(value); setShowNotes(false); setEditor(null); }} onSaved={reloadCurrent} onClose={() => setEditor(null)} /> : <>
        <section className="t1-notes-section"><h3>{t("t1.systemNotes")}</h3><p>{t("t1.disclaimer")}</p>{presentation.sourceLimited && <p className="t1-notes-warning">{t("t1.sourceLimitsHint")}</p>}{runId && (!presentation.ended || !presentation.taskComplete) && <p className="t1-notes-warning">{t(`t1.${presentation.hintKey}`)}</p>}{sourceBlocked && <p className="t1-notes-warning">{t("t1.sourceProblem")}</p>}
          {record && <><h4>{t("t1.figureRelationship")}</h4><p>{t(record.association === "paired" ? "t1.pairedFigureCount" : record.association === "pending" ? "t1.pendingPair" : record.association === "not_checked" ? "t1.notChecked" : "t1.noPair", { count: record.figure_ids.length })}</p></>}
          {record?.labels?.comment && <aside className="t1-reviewer-comment"><strong>{t("t1.comment")}</strong><p>{record.labels.comment}</p></aside>}
        </section>
        {runId && <TaskCompletionNotes entries={batchId && selectedGroup ? selectedGroup.runs.map(run => ({ run: batchResults.details[run.run_id]?.run ?? run, coverage: batchResults.details[run.run_id]?.output.coverage, label: originalRunFilename(run, papers.find(paper => paper.id === run.document_id)), gaps: batchResults.details[run.run_id]?.output.source_gaps, pdfUrl: batchResults.details[run.run_id]?.pdf_url })) : displayedRun ? [{ run: displayedRun, coverage: output?.coverage, gaps: output?.source_gaps, pdfUrl }] : []} />}
        {runId && <details className="t1-technical-details"><summary>{t("t1.currentTaskEvents")}</summary><p className="t1-stream-status">{t(`t1.${connection}`)}</p>{events.length ? <ol className="t1-events">{events.map(event => <li key={event.seq}><span>#{event.seq} · {event.type}</span><p>{event.summary}</p><time>{event.timestamp}</time></li>)}</ol> : <p>{t("t1.noEvents")}</p>}</details>}
        <section className="t1-notes-section"><h3>{t("t1.sourceInformation")}</h3>{displayedRun?.model_id && <p data-run-model={displayedRun.model_id}>{t("t1.extractionModel")}: {displayedRun.model_id}{displayedRun.model_profile && ` · ${displayedRun.model_profile.api} · ${displayedRun.model_profile.reasoning_effort === "none" ? t("t1.noReasoningParameter") : displayedRun.model_profile.reasoning_effort}`}</p>}<p>{t("t1.fragmentsSeparate")}</p>{output?.scope && <details className="t1-note-disclosure"><summary>{t("t1.runScope")}</summary><ScopeSummary scope={output.scope} snapshot={output.scope_catalog} historical /></details>}
          {record && <SameSourceMembers index={output?.same_source_review_index} record={record} records={recordDetail?.output.records ?? records} onSelect={id => { const member = records.find(item => item.id === id && item.run_id === record.run_id); setRecordQuery(""); setRecordRole("all"); setRetentionView(member ? retainedStatus(member) : "kept"); setRecordId(member ? resultRecordKey(member) : id); setShowNotes(false); }} />}
        </section>
        {editable && !sourceBlocked && <section className="t1-notes-section"><h3>{t("t1.moreActions")}</h3>{record && <button className="t1-button" onClick={() => setEditor({ run: operationRunId!, record: record.id })}>{t("t1.sourceCorrection")}</button>}<button className="t1-button" onClick={() => setEditor({ run: operationRunId!, record: null })}>{t("t1.add")}</button></section>}
        <details className="t1-technical-details"><summary>{t("t1.sourceLocationVersion")}</summary>{record && <><p>{t("t1.version", { version: record.version })}</p><code>{record.id} · {record.run_id} · {record.text_fingerprint}</code><h4>{t("t1.sourceDetails")}</h4>{[...record.fragments, ...record.context].map((fragment, i) => <code key={i}>{t("t1.physicalPage", { page: fragment.physical_page })} · {fragment.block_id} · {fragment.start}–{fragment.end} · {fragment.text_version}</code>)}
          <details><summary>{t("t1.originalFields")}</summary><pre>{JSON.stringify({ figure_association: record.association, proposed_figure_ids: record.proposed_figure_ids, figures: figures.filter(figure => record.figure_ids.includes(figure.id)).map(({ id, number, verification, human_approved }) => ({ id, number, verification, human_approved })) }, null, 2)}</pre>{record.reasons.map((reason, i) => <p key={i}>{reason}</p>)}{record.model_primary_assessment && <pre>{JSON.stringify(record.model_primary_assessment, null, 2)}</pre>}{record.labels && <pre>{JSON.stringify(record.labels, null, 2)}</pre>}</details>{(record.review_reason || record.text_approved || record.review_status === "rejected") && <details className="t1-legacy-review"><summary>{t("t1.legacyReviewInfo")}</summary><p>{record.review_status}</p>{record.review_reason && <p>{record.review_reason}</p>}</details>}</>}{runId && <p className="t1-stream-status">{t(`t1.${connection}`)}</p>}{paper && <code>PDF SHA256 {paper.sha256}</code>}</details>
      </>}
    </WorkbenchNotes>
    <SidebarMenu open={menu !== null} anchor={menu} sheet={mobile} ariaLabel={t("t1.theme")} title={t("t1.theme")} cancelLabel={t("t1.close")} onClose={() => setMenu(null)} items={([['auto', 'system'], ['light', 'light'], ['dark', 'dark']] as const).map(([id, key]) => ({ type: "item", id, label: t(`t1.${key}`), checked: preference === id, onSelect: () => setThemePreference(id) }))} />
    <RunTaskMenu menu={taskMenu} run={runs.find(run => run.run_id === taskMenu?.runId)} paper={papers.find(paper => paper.id === taskMenu?.paperId)} members={taskGroups.find(group => group.runs.some(run => run.run_id === taskMenu?.runId))?.runs} cancelling={cancelling} mobile={mobile} onClose={() => setTaskMenu(null)} onCancel={run => void cancelRun(run.run_id)} onView={selectRun} onDelete={requestRunDeletion} />
    <RunDeleteDialog target={deleteTarget} busy={deleteBusy} cleanupPending={Boolean(cleanupTarget && cleanupTarget.runId === deleteTarget?.runId)} blocked={Boolean(deleteTarget && runs.some(run => (run.run_id === deleteTarget.runId || deleteTarget.members?.some(member => member.runId === run.run_id)) && runDeletionBlocked(run)))} error={deleteError} onClose={() => setDeleteTarget(null)} onConfirm={target => void deleteRun(target)} />
    <StorageManagement open={showStorage} onClose={() => setShowStorage(false)} onCleaned={refreshStoragePapers} />
  </div>;
}
