"use client";

import { useEffect, useRef, useState } from "react";
import type { WorkbenchRun, WorkbenchRunDetail } from "../../../packages/contracts/src/workbench";
import { api } from "./api";
import { canCancelRun } from "./task-actions";

/** Every detail is checked against this exact submission; a paper's latest result is never a fallback. */
export function useBatchResults(batchId: string | undefined, members: readonly WorkbenchRun[], revision: number, errorText: (cause: unknown) => string) {
  const [saved, setSaved] = useState<{ batch: string; details: Record<string, WorkbenchRunDetail>; errors: Record<string, string>; loading: boolean } | null>(null);
  const membersRef = useRef(members), errorRef = useRef(errorText), reloadRef = useRef<(id?: string) => Promise<void>>(async () => {});
  membersRef.current = members; errorRef.current = errorText;
  const signature = members.map(run => `${run.run_id}:${run.state}:${run.result_ready}:${run.task_processing_complete}`).sort().join(",");
  useEffect(() => {
    if (!batchId) return;
    const controller = new AbortController(); let flight: Promise<void> | null = null, dirty = false;
    const batch = batchId;
    async function load(id?: string) {
      if (controller.signal.aborted) return;
      if (flight) { dirty = true; return flight; }
      flight = (async () => {
        do {
          dirty = false;
          const targets = membersRef.current.filter(run => !id || run.run_id === id);
          // Keep memory and source reads bounded for a twenty-paper batch.
          for (let offset = 0; offset < targets.length && !controller.signal.aborted; offset += 4) {
            await Promise.all(targets.slice(offset, offset + 4).map(async run => {
              try {
                const detail = await api<WorkbenchRunDetail>(`workbench/runs/${encodeURIComponent(run.run_id)}`, { signal: controller.signal });
                if (detail.run.run_id !== run.run_id || detail.run.document_id !== run.document_id || detail.paper.id !== run.document_id || detail.output.id !== run.run_id || detail.run.submission?.kind !== "batch" || detail.run.submission.batch_id !== batch || detail.output.records.some(record => record.run_id !== run.run_id)) throw new Error("batch_result_binding_mismatch");
                if (!controller.signal.aborted) setSaved(current => { const value = current?.batch === batch ? current : { batch, details: {}, errors: {}, loading: true }; const errors = { ...value.errors }; delete errors[run.run_id]; return { ...value, details: { ...value.details, [run.run_id]: detail }, errors }; });
              } catch (cause) {
                if (!controller.signal.aborted) setSaved(current => { const value = current?.batch === batch ? current : { batch, details: {}, errors: {}, loading: true }; return { ...value, errors: { ...value.errors, [run.run_id]: errorRef.current(cause) } }; });
              }
            }));
          }
          if (!controller.signal.aborted) setSaved(current => ({ ...(current?.batch === batch ? current : { batch, details: {}, errors: {} }), loading: false }));
          id = undefined;
        } while (dirty && !controller.signal.aborted);
      })();
      try { await flight; } finally { flight = null; }
    }
    reloadRef.current = load; void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible" && membersRef.current.some(run => canCancelRun(run) || run.result_ready === false)) void load(); }, 10000);
    return () => { controller.abort(); window.clearInterval(timer); if (reloadRef.current === load) reloadRef.current = async () => {}; };
  }, [batchId, signature, revision]);
  const current = saved?.batch === batchId ? saved : null;
  return { details: current?.details ?? {}, errors: current?.errors ?? {}, loading: Boolean(batchId && (!current || current.loading)), reload: (id?: string) => reloadRef.current(id) };
}
