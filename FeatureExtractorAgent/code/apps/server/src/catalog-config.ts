import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ContractError, scopeCatalogConfigIssues, type EvidenceCatalog, type ScopeCatalogConfig, type ScopeCatalogIssue } from '@t1/contracts';

export const SCOPE_CATALOG_FILE = 'config/scope-catalog.json';
export const MAX_SCOPE_CATALOG_BYTES = 1024 * 1024;
const codeRoot = fileURLToPath(new URL('../../../', import.meta.url));
export class ScopeCatalogConfigError extends ContractError {
  constructor(code: string, readonly issues: ScopeCatalogIssue[] = []) { super(code); }
}
export function decodeScopeCatalog(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_SCOPE_CATALOG_BYTES) throw new ScopeCatalogConfigError('scope_catalog_too_large');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ScopeCatalogConfigError('scope_catalog_json_invalid'); }
  const issues = scopeCatalogConfigIssues(value);
  if (issues.length) throw new ScopeCatalogConfigError('scope_catalog_invalid', issues);
  const config = value as ScopeCatalogConfig, sha256 = createHash('sha256').update(bytes).digest('hex');
  const source = SCOPE_CATALOG_FILE, status = 'operator_configured' as const;
  const named = (entry: ScopeCatalogConfig['image_types'][number]) => ({ id: entry.id, name: entry.name,
    synonyms: (entry.aliases ?? []).map(text => ({ text, source, approval_status: status })), source, approval_status: status,
    ...(entry.description !== undefined ? { description: entry.description } : {}) });
  const catalog: EvidenceCatalog = { catalog_version: `scope-${sha256}`, status, fixture: false,
    cancers: config.cancers.map(named), image_types: config.image_types.map(entry => ({ ...named(entry),
      cancer_ids: config.cancers.filter(cancer => cancer.image_type_ids.includes(entry.id)).map(cancer => cancer.id) })),
    features: [], bindings: [] };
  return { config, catalog, sha256, byte_length: bytes.byteLength };
}
/** Fixed operator source, bounded and re-read for each GET/admission. Invalid edits never reuse an old value. */
export function readScopeCatalog(root = codeRoot) {
  let fd: number | undefined;
  try {
    fd = openSync(resolve(root, SCOPE_CATALOG_FILE), 'r');
    const bytes = Buffer.alloc(MAX_SCOPE_CATALOG_BYTES + 1); let length = 0;
    while (length < bytes.length) { const read = readSync(fd, bytes, length, bytes.length - length, length); if (!read) break; length += read; }
    return decodeScopeCatalog(bytes.subarray(0, length));
  } catch (error) {
    if (error instanceof ScopeCatalogConfigError) throw error;
    throw new ScopeCatalogConfigError('scope_catalog_unavailable');
  } finally { if (fd !== undefined) closeSync(fd); }
}
