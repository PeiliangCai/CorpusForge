"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CloseIcon } from "@/components/SidebarIcons";

export type GlobalToastNotice = { text: string; failed?: boolean; busy?: boolean };
export type GlobalToastItem = {
  id: string;
  /** Pass the saved notice object itself: a replacement restarts the timer. */
  notice: GlobalToastNotice;
  action?: ReactNode;
  onDismiss?: () => void;
  /** Only for an ongoing recovery action that has no other persistent entry. */
  persistent?: boolean;
  className?: string;
};

const SUCCESS_MS = 4_000, ERROR_MS = 6_000, EXIT_MS = 180;

function GlobalToast({ item, dismissLabel }: { item: GlobalToastItem; dismissLabel: string }) {
  const { notice, persistent } = item;
  const [exiting, setExiting] = useState<GlobalToastNotice | null>(null);
  const dismissRef = useRef(item.onDismiss);
  dismissRef.current = item.onDismiss;
  const leaving = exiting === notice;

  // Polling, navigation and fresh action elements do not extend a toast's life.
  // New notices, including an identical message from another action, do.
  useEffect(() => {
    if (notice.busy || persistent) return;
    const timer = window.setTimeout(() => setExiting(notice), notice.failed ? ERROR_MS : SUCCESS_MS);
    return () => window.clearTimeout(timer);
  }, [notice, persistent]);
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => dismissRef.current?.(), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, notice]);

  return <div className={`t1-refresh-toast${item.className ? ` ${item.className}` : ""}`} data-toast-id={item.id} data-failed={Boolean(notice.failed)} data-busy={Boolean(notice.busy)} data-leaving={leaving} aria-busy={notice.busy} role={notice.failed ? "alert" : "status"} aria-atomic="true">
    <span className="t1-toast-symbol" aria-hidden="true">{notice.busy ? <span className="t1-toast-spinner" /> : notice.failed ? "!" : "✓"}</span>
    <span className="t1-toast-message">{notice.text}</span>
    {item.action && <span className="t1-toast-actions">{item.action}</span>}
    {item.onDismiss && <button type="button" className="t1-refresh-dismiss" aria-label={dismissLabel} onClick={() => setExiting(notice)}><CloseIcon size={16} /></button>}
  </div>;
}

/** One viewport overlay, outside page content, so messages survive tab changes. */
export function GlobalToasts({ items, dismissLabel }: { items: GlobalToastItem[]; dismissLabel: string }) {
  return <div className="t1-toast-stack">{items.map(item => <GlobalToast key={item.id} item={item} dismissLabel={dismissLabel} />)}</div>;
}
