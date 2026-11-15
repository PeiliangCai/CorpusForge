"use client";

import { useState, type ReactNode } from "react";
import { WorkbenchNotes } from "./WorkbenchNotes";

/** Main-page disclosures stay outside document flow, with native focus and
 * Escape behavior and one bounded scrolling surface for any content length. */
export function DetailDisclosure({ title, children, className = "" }: { title: string; children: ReactNode | ((close: () => void) => ReactNode); className?: string }) {
  const [open, setOpen] = useState(false);
  return <div className={`t1-detail-disclosure ${className}`}>
    <button type="button" className="t1-link" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>{title}</button>
    <WorkbenchNotes variant="details" open={open} title={title} onClose={() => setOpen(false)}>{typeof children === "function" ? children(() => setOpen(false)) : children}</WorkbenchNotes>
  </div>;
}
