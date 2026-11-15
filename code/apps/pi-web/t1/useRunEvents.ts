"use client";
import { useEffect, useState } from "react";
import { retainProgressEvent, type ProgressEvent } from "./run-progress";

export interface RunEvent { seq: number; type: string; summary: string; stage: string; timestamp: string; fixture: boolean; detail?: Record<string, unknown> }
/** Generic SSE framing; unlike a fixed event-name list, this keeps every typed business event. */
export function useRunEvents(runId: string | null, workbench = false) {
  const [eventSnapshot, setEventSnapshot] = useState<{ id: string | null; items: RunEvent[] }>({ id: null, items: [] });
  const [progressSnapshot, setProgressSnapshot] = useState<{ id: string | null; items: readonly ProgressEvent[] }>({ id: null, items: [] });
  const [connectionSnapshot, setConnectionSnapshot] = useState({ id: runId, status: "noSelectedTask" });
  useEffect(() => {
    setEventSnapshot({ id: runId, items: [] });
    setProgressSnapshot({ id: runId, items: [] });
    const setConnection = (status: string) => setConnectionSnapshot({ id: runId, status });
    if (!runId) { setConnection("noSelectedTask"); return; }
    const controller = new AbortController();
    let cursor = 0;
    async function connect() {
      while (!controller.signal.aborted) {
        try {
          setConnection(cursor ? "reconnecting" : "connecting");
          const response = await fetch(`/api/t1/${workbench ? "workbench/" : ""}runs/${encodeURIComponent(runId!)}/events?after=${cursor}`, { signal: controller.signal, cache: "no-store" });
          if (controller.signal.aborted) { await response.body?.cancel().catch(() => {}); return; }
          if (!response.ok || !response.body) throw new Error("stream_unavailable");
          setConnection("connected");
          const reader = response.body.getReader(), decoder = new TextDecoder();
          let pending = "";
          try {
            while (!controller.signal.aborted) {
              const { done, value } = await reader.read();
              if (done || controller.signal.aborted) break;
              pending += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
              let boundary;
              while (!controller.signal.aborted && (boundary = pending.indexOf("\n\n")) >= 0) {
                const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
                const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
                if (!data) continue;
                const value = JSON.parse(data) as RunEvent & { run_id?: string; detail?: { summary?: string; state?: string; controlled_fixture?: boolean } };
                if (value.run_id && value.run_id !== runId) continue;
                const event: RunEvent = { ...value, summary: value.summary ?? value.detail?.summary ?? value.type, stage: value.stage ?? value.detail?.state ?? "", fixture: value.fixture ?? value.detail?.controlled_fixture ?? false };
                if (!Number.isSafeInteger(event.seq) || event.seq <= cursor) continue;
                cursor = event.seq;
                setEventSnapshot(previous => ({ id: runId, items: [...(previous.id === runId ? previous.items : []).filter(item => item.seq !== event.seq), event].slice(-500) }));
                if (["state", "coverage_inventory", "batch"].includes(event.type)) setProgressSnapshot(previous => ({ id: runId, items: retainProgressEvent(previous.id === runId ? previous.items : [], event) }));
              }
            }
          } finally { await reader.cancel().catch(() => {}); }
          if (!controller.signal.aborted) throw new Error("stream_closed");
        } catch {
          if (controller.signal.aborted) break;
          setConnection("reconnecting");
          await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); };
            const timer = window.setTimeout(finish, 1500);
            controller.signal.addEventListener("abort", finish, { once: true });
          });
        }
      }
    }
    void connect();
    return () => controller.abort();
  }, [runId, workbench]);
  return { events: eventSnapshot.id === runId ? eventSnapshot.items : [],
    progressEvents: progressSnapshot.id === runId ? progressSnapshot.items : [],
    connection: connectionSnapshot.id === runId ? connectionSnapshot.status : runId ? "connecting" : "noSelectedTask" };
}
