"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { CloseIcon } from "@/components/SidebarIcons";
import { useI18n } from "@/hooks/useI18n";

/** The native dialog supplies Escape, focus containment and return-to-trigger focus. */
export function WorkbenchNotes({ open, title, onClose, children, variant = "notes", footer, busy = false }: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  variant?: "notes" | "creation" | "details";
  footer?: ReactNode;
  busy?: boolean;
}) {
  const { t } = useI18n();
  const panel = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null), titleId = useId();
  useEffect(() => {
    const dialog = panel.current;
    if (open && !dialog?.open) { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; dialog?.showModal(); }
    else if (!open && dialog?.open) dialog.close();
  }, [open]);

  return <dialog ref={panel} className={variant === "notes" ? "t1-notes" : variant === "creation" ? "t1-creation-dialog" : "t1-detail-dialog"} aria-labelledby={titleId} onCancel={event => {
    if (busy) event.preventDefault();
  }} onClose={() => {
    if (opener.current?.isConnected && opener.current.getClientRects().length) opener.current.focus({ preventScroll: true });
    onClose();
  }} onKeyDown={event => {
    if (variant === "notes" || event.key !== "Escape") return;
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) event.preventDefault();
  }} onClick={event => {
    if (busy) return;
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
  }}>
    <header className="t1-notes-heading"><h2 id={titleId}>{title}</h2><button type="button" autoFocus className="t1-icon-button" disabled={busy} aria-label={t(variant === "notes" ? "t1.closeNotes" : "t1.close")} onClick={onClose}><CloseIcon size={18} /></button></header>
    <div className="t1-notes-content">{children}</div>
    {footer && <footer className="t1-dialog-footer">{footer}</footer>}
  </dialog>;
}
