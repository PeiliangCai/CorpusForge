import type { WorkbenchPaper, WorkbenchRun } from "../../../packages/contracts/src/workbench";

export function originalRunFilename(run: WorkbenchRun, paper?: WorkbenchPaper) {
  return run.original_filename ?? paper?.filename ?? paper?.title ?? run.document_id;
}
/** New names belong to the run/submission. Legacy rows are displayed without mutation. */
export function taskDisplayTitle(run: WorkbenchRun, paper?: WorkbenchPaper) {
  const filename = originalRunFilename(run, paper);
  if (run.submission?.kind === "batch") return run.task_title ? `${run.task_title} · ${filename}` : filename;
  return run.task_title ?? paper?.title ?? filename;
}
