export const MAX_PDF_FILES = 20, MAX_PDF_FILE_BYTES = 50 * 1024 * 1024;
type PdfFile = Pick<File, "name" | "size" | "arrayBuffer">;
export class SelectionLimitError extends Error {
  constructor(readonly count: number, readonly remaining: number) { super("pdf_selection_limit"); }
}
/** Read one bounded file at a time. Neither metadata nor a filename proves identity. */
export async function preparePdfSelection<T extends PdfFile>(files: readonly T[], existing: ReadonlySet<string>, remaining: number) {
  const seen = new Set(existing), selected: { file: T; sha256?: string; invalid: boolean }[] = [];
  let duplicates = 0;
  for (const file of files) {
    const invalid = !/\.pdf$/i.test(file.name) || file.size === 0 || file.size > MAX_PDF_FILE_BYTES || file.name.length > 240;
    let sha256: string | undefined;
    if (!invalid) {
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      if (seen.has(sha256)) { duplicates++; continue; }
      seen.add(sha256);
    }
    selected.push({ file, sha256, invalid });
    if (selected.length > remaining) throw new SelectionLimitError(selected.length, remaining);
  }
  return { selected, duplicates };
}
