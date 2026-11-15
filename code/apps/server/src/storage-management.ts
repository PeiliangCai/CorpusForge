import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, unlinkSync } from 'node:fs';
import { lstat, readdir, statfs } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { ContractError } from '@t1/contracts';
import type { ExtractionStore } from '@t1/agent';
import type { WorkbenchStorageCandidate, WorkbenchStorageCategory, WorkbenchStorageCleanupInput,
  WorkbenchStorageCleanupResult, WorkbenchStoragePart, WorkbenchStoragePreview, WorkbenchStorageSummary } from '../../../packages/contracts/src/workbench.js';

const HOUR = 3600_000, PREVIEW_MS = 10 * 60_000;
const MAX_PREVIEWS = 32, MAX_RECEIPTS = 128, MAX_FILES = 100_000;
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const runId = new RegExp(`^run-${uuid}$`, 'u'), exportId = new RegExp(`^export-${uuid}$`, 'u');
const inside = (parent: string, child: string) => { const value = relative(parent, child); return value === '' || value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value); };
const categories: WorkbenchStorageCategory[] = ['pdf', 'parse', 'figures', 'exports', 'other'];
const parts = () => categories.map(kind => ({ kind, bytes: 0, files: 0 }));
type Protection = WorkbenchStorageSummary['protected_reasons'][number]['code'];
interface Identity { dev: number; ino: number; size: number; mtime: number; ctime: number; mode: number; nlink: number }
const identity = (value: NonNullable<ReturnType<typeof lstatSync>>): Identity => ({ dev: Number(value.dev), ino: Number(value.ino), size: Number(value.size),
  mtime: Number(value.mtimeMs), ctime: Number(value.ctimeMs), mode: Number(value.mode), nlink: Number(value.nlink) });
const sameDirectory = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameFile = (a: Identity, b: Identity) => sameDirectory(a, b) && a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime && a.nlink === b.nlink;
interface OwnedFile { path: string; identity: Identity; category: WorkbenchStorageCategory; owner: string; kind: WorkbenchStorageCandidate['kind']; known: boolean; regular: boolean; link: boolean }
interface Paper { id: string; title: string; pdf: { path: string; sha256: string }; uploaded: boolean; uploaded_at?: string; last_uploaded_at?: string; paths: Set<string> }
interface References {
  hash: string; papers: Paper[]; strong: Set<string>; all: Set<string>; hashes: Set<string>; allHashes: Set<string>; strings: Set<string>;
  immutable: Set<string>; knownRuns: Set<string>;
}
interface CandidatePlan { value: WorkbenchStorageCandidate; files: OwnedFile[] }
interface Scan { summary: WorkbenchStorageSummary; version: string; candidates: CandidatePlan[]; directories: Record<string, Identity>; referenceHash: string }
interface StoredPlan { preview: WorkbenchStoragePreview; candidates: CandidatePlan[]; directories: Record<string, Identity>; referenceHash: string;
  selection?: string[]; removed_paper_ids?: string[]; results?: WorkbenchStorageCleanupResult['results']; done_files?: string[];
  receipt?: Omit<WorkbenchStorageCleanupResult, 'summary'> }
interface Host {
  codeRoot: string; directory: string; store: ExtractionStore;
  busy(): boolean;
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  papersRemoved(ids: string[]): void;
  /** Isolated tests may control the clock without changing production retention policy. */
  now?: () => number;
}

/** Explicitly requested cleanup only. No timer or startup hook removes storage. */
export class WorkbenchStorage {
  private readonly clock: () => number;
  private cleaning = false;
  constructor(private readonly host: Host) {
    this.clock = host.now ?? Date.now;
    host.store.db.exec(`CREATE TABLE IF NOT EXISTS workbench_storage_operations(
      id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL,payload_json TEXT NOT NULL)`);
  }

  private roots() {
    return [resolve(this.host.directory, 'pdf'), resolve(this.host.directory, 'runs'), resolve(this.host.directory, 'figure-reviews'),
      resolve(this.host.directory, 'exports'), resolve(this.host.codeRoot, 'runtime-data/s3-native-artifacts')];
  }

  /** Every persisted JSON column participates, including legacy versions, reviews and exports.
   * An unreadable/unknown JSON value fails the entire eligibility decision closed. */
  private references(): References {
    const { db } = this.host.store, rows: unknown[] = [], papers: Paper[] = [];
    const managedRoots = this.roots();
    // Every path inside these five fixed roots necessarily contains one of
    // these complete components. Avoid normalizing every large prose string.
    const managedComponent = /(?:^|\/)(?:pdf|runs|figure-reviews|exports|s3-native-artifacts)(?:\/|$)/u;
    const strong = new Set<string>(), all = new Set<string>(), hashes = new Set<string>(), allHashes = new Set<string>(), strings = new Set<string>();
    const immutable = new Set<string>(), knownRuns = new Set<string>();
    const collect = (value: unknown, paths: Set<string>, identityHashes: Set<string>, identities?: Set<string>) => {
      const stack: Array<{ value: unknown; key: string }> = [{ value, key: '' }]; let visited = 0;
      while (stack.length) {
        if (++visited > 1_000_000) throw new Error('reference_inventory_limit');
        const { value: item, key } = stack.pop()!;
        if (typeof item === 'string') {
          identities?.add(item);
          if (/^[a-f0-9]{64}$/u.test(item)) identityHashes.add(item);
          if (item && !item.includes('\0')) {
            const explicit = ['path', 'file_reference', 'directory'].includes(key) || key.endsWith('_path');
            if (!explicit && !managedComponent.test(item)) continue;
            const path = resolve(this.host.codeRoot, item);
            // Native source text can literally be '/'. Only explicit reference
            // fields may protect an ancestor outside the five managed roots.
            if (explicit || managedRoots.some(root => inside(root, path))) paths.add(path);
          }
        } else if (item && typeof item === 'object') for (const [key, value] of Object.entries(item)) stack.push({ key, value });
      }
    };
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    for (const tableRow of tables) {
      const table = tableRow.name as string;
      if (!/^[A-Za-z0-9_]+$/u.test(table)) throw new Error('unknown_reference_table');
      if (table === 'workbench_storage_operations') continue;
      const values = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
      rows.push([table, values]);
      const tombstone = ['workbench_deleted_runs', 'workbench_deleted_batches', 'workbench_deleted_sources', 'workbench_requests'].includes(table);
      for (const row of values) {
        const parsed: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) parsed[key] = key.endsWith('_json') && typeof value === 'string' ? JSON.parse(value) : value;
        if (table === 'workbench_deleted_runs' && typeof row.run_id === 'string') knownRuns.add(row.run_id);
        if (table === 'workbench_runs') {
          const payload = parsed.payload_json as Record<string, unknown>;
          if (!payload || payload.id !== row.id || payload.paper_id !== row.paper_id || typeof payload.directory !== 'string') throw new Error('invalid_run_reference');
          knownRuns.add(row.id as string);
          if (payload.directory) strong.add(resolve(this.host.codeRoot, payload.directory));
          // The CPU parser stores its native JSON separately from the run directory.
          strong.add(resolve(this.host.codeRoot, 'runtime-data/s3-native-artifacts', row.id as string));
        }
        if (table === 'workbench_papers') {
          const value = parsed.payload_json as Record<string, unknown>, pdf = value?.pdf as Paper['pdf'] | undefined;
          if (!value || value.id !== row.id || !pdf || typeof pdf.path !== 'string' || !/^[a-f0-9]{64}$/u.test(pdf.sha256)) throw new Error('invalid_paper_reference');
          const paths = new Set<string>(); collect(value, paths, allHashes);
          for (const path of paths) all.add(path);
          const paper: Paper = { id: row.id as string, title: typeof value.title === 'string' ? value.title : 'PDF', pdf, uploaded: value.uploaded === true, paths,
            ...(typeof value.uploaded_at === 'string' ? { uploaded_at: value.uploaded_at } : {}), ...(typeof value.last_uploaded_at === 'string' ? { last_uploaded_at: value.last_uploaded_at } : {}) };
          papers.push(paper);
          if (!paper.uploaded) for (const path of paths) immutable.add(path);
        } else if (!tombstone) {
          collect(parsed, strong, hashes, strings); collect(parsed, all, allHashes);
          if (table === 'workbench_exports') {
            const directory = (parsed.payload_json as { directory?: unknown } | undefined)?.directory;
            if (typeof directory !== 'string' || !directory) throw new Error('invalid_export_reference');
            for (const path of [resolve(this.host.codeRoot, directory), resolve(this.host.codeRoot, directory) + '.tar.gz']) { strong.add(path); all.add(path); }
          }
        }
      }
    }
    return { hash: sha(rows), papers, strong, all, hashes, allHashes, strings, immutable, knownRuns };
  }

  private recognition(path: string, knownRuns: Set<string>): Pick<OwnedFile, 'category' | 'known' | 'owner' | 'kind'> {
    const [pdf, runs, reviews, exports, native] = this.roots();
    const result = (category: WorkbenchStorageCategory, known: boolean, owner: string, kind: WorkbenchStorageCandidate['kind']) => ({ category, known, owner, kind });
    if (inside(pdf!, path)) { const rel = relative(pdf!, path); return result('pdf', /^[a-f0-9]{64}\.pdf$/u.test(rel), rel, 'orphan_pdf'); }
    if (inside(runs!, path)) {
      const [id = '', ...rest] = relative(runs!, path).split(sep), name = rest.join('/');
      const image = /^figure-assets\/(?:catalog\.json|(?:figure|region)-[a-f0-9]{24}-p\d+-\d+\.png)$/u.test(name);
      const generated = /^(?:document-ir|figure-catalog|figure-discovery-input|article-scope|source-selection|batch-plan|paragraph-plan|source-invalidated|request-ledger|result|delivery|whole-document-summary)\.json$/u.test(name)
        || /^batch-\d+-attempt-\d+\.json$/u.test(name) || /^whole-document-summary-attempt-\d+\.json$/u.test(name)
        || /^(?:docling-standard-cpu|mineru-basic-onnx-cpu)-\d+-\d+\.stderr\.log$/u.test(name);
      return result(image ? 'figures' : generated ? 'parse' : 'other', runId.test(id) && (image || generated), id, image ? 'orphan_figures' : 'orphan_parse');
    }
    if (inside(reviews!, path)) {
      const rel = relative(reviews!, path).replaceAll(sep, '/');
      return result('figures', new RegExp(`^[a-f0-9]{64}/${uuid}\\.json$`, 'u').test(rel), rel.split('/')[0]!, 'orphan_figures');
    }
    if (inside(exports!, path)) {
      const [id = '', ...rest] = relative(exports!, path).split(sep), name = rest.join('/');
      const archive = id.endsWith('.tar.gz') && exportId.test(id.slice(0, -7)) && !rest.length;
      const generated = /^(?:records|background-records|table-support)\.(?:jsonl|csv)$/u.test(name)
        || /^(?:delivery|coverage|source-glyph-audit|sample-audit|reviews|manifest|human-annotations|retention)\.json$/u.test(name)
        || name === 'source-record-versions.jsonl' || /^(?:figures|review-materials)\/[a-f0-9]{32}\.png$/u.test(name);
      return result('exports', archive || exportId.test(id) && generated, archive ? id.slice(0, -7) : id, 'orphan_export');
    }
    if (inside(native!, path)) {
      const [id = '', ...rest] = relative(native!, path).split(sep);
      return result('parse', runId.test(id) && knownRuns.has(id) && rest.length === 1 && /^(?:docling-standard-cpu|mineru-basic-onnx-cpu)-[a-f0-9]{64}\.json$/u.test(rest[0]!), id, 'orphan_parse');
    }
    return result('other', false, '', 'orphan_parse');
  }

  private referenced(path: string, references: ReadonlySet<string>) {
    for (const reference of references) if (inside(reference, path)) return true;
    return false;
  }

  private async scan(ignoreCleaning = false): Promise<Scan> {
    const now = this.clock(), directories: Record<string, Identity> = {}, files: OwnedFile[] = [];
    let complete = true, refs: References | undefined, referenceError = false;
    try { refs = this.references(); } catch { referenceError = true; }
    const knownRuns = refs?.knownRuns ?? new Set<string>();
    // Every component is checked; even a configured root symlink is never traversed.
    const ancestors = async (path: string): Promise<boolean> => {
      const parent = dirname(path);
      if (parent !== path && !await ancestors(parent)) return false;
      try { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) { complete = false; return false; }
        directories[path] = identity(info); return true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false; return false; }
    };
    const walk = async (path: string, depth: number): Promise<void> => {
      if (depth > 32 || files.length >= MAX_FILES) { complete = false; return; }
      let entries;
      try { entries = await readdir(path, { withFileTypes: true }); } catch { complete = false; return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (files.length >= MAX_FILES) { complete = false; return; }
        const child = resolve(path, entry.name);
        try {
          const info = await lstat(child);
          if (info.isDirectory() && !info.isSymbolicLink()) { directories[child] = identity(info); await walk(child, depth + 1); }
          else files.push({ path: child, identity: identity(info), regular: info.isFile(), link: info.isSymbolicLink() || info.nlink > 1,
            ...this.recognition(child, knownRuns) });
        } catch { complete = false; }
      }
    };
    for (const root of this.roots()) {
      if (await ancestors(root)) await walk(root, 0);
      else {
        // Missing optional roots are empty. A present unsafe root disables eligibility.
        try { await lstat(root); complete = false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false; }
      }
    }
    if (refs) try { if (this.references().hash !== refs.hash) complete = false; } catch { referenceError = true; }
    const busy = this.host.busy() || this.cleaning && !ignoreCleaning;
    const strong = new Set(refs?.strong), recent = new Set<string>(), immutable = refs?.immutable ?? new Set<string>();
    const fileMap = new Map(files.map(file => [file.path, file]));
    const unused: Paper[] = [], dates = new Map<string, number>();
    for (const paper of refs?.papers ?? []) {
      const pdf = resolve(this.host.codeRoot, paper.pdf.path), file = fileMap.get(pdf);
      const timestamps = [paper.uploaded_at, paper.last_uploaded_at].filter((value): value is string => Boolean(value)).map(Date.parse);
      if (file) timestamps.push(file.identity.mtime, file.identity.ctime);
      const last = timestamps.length && timestamps.every(Number.isFinite) ? Math.max(...timestamps) : NaN;
      dates.set(paper.id, last);
      const used = !paper.uploaded || refs!.strings.has(paper.id) || refs!.hashes.has(paper.pdf.sha256);
      const isRecent = !Number.isFinite(last) || now - last < 24 * HOUR;
      if (used || isRecent) for (const path of paper.paths) { strong.add(path); if (!used && isRecent) recent.add(path); }
      else unused.push(paper);
    }
    // A recent/retained/shared owner's PDF also protects older unused duplicates.
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = unused.length - 1; index >= 0; index--) {
        const paper = unused[index]!;
        if (this.referenced(resolve(this.host.codeRoot, paper.pdf.path), strong)) {
          for (const path of paper.paths) strong.add(path);
          unused.splice(index, 1); changed = true;
        }
      }
    }
    const parent = new Map(unused.map(paper => [paper.id, paper.id]));
    const find = (id: string): string => { const value = parent.get(id)!; return value === id ? id : find(value); };
    const pathOwner = new Map<string, string>();
    for (const paper of unused) for (const path of paper.paths) { const other = pathOwner.get(path); if (other) parent.set(find(paper.id), find(other)); else pathOwner.set(path, paper.id); }
    const groups = new Map<string, Paper[]>();
    for (const paper of unused) { const id = find(paper.id); groups.set(id, [...groups.get(id) ?? [], paper]); }
    const candidateMap = new Map<string, CandidatePlan>(), protectedReasons = new Map<Protection, { code: Protection; bytes: number; files: number }>();
    const summary: WorkbenchStorageSummary = { schema_version: 't1-storage-summary-1', observed_at: new Date(now).toISOString(), scope: 'managed_workbench_files',
      total_bytes: 0, protected_bytes: 0, reclaimable_bytes: 0, unknown_bytes: 0, file_count: 0, categories: parts(), protected_reasons: [], disk: null,
      cleanup_available: complete && !referenceError && !busy, policy: { automatic_cleanup: false, recent_upload_protection_hours: 24 },
      ...(referenceError ? { unavailable_reason: 'storage_reference_unavailable' as const } : !complete ? { unavailable_reason: 'storage_scope_unavailable' as const } : busy ? { unavailable_reason: 'storage_busy' as const } : {}) };
    const seen = new Set<string>();
    for (const file of files) {
      const inode = `${file.identity.dev}:${file.identity.ino}`; if (seen.has(inode)) continue; seen.add(inode);
      const bytes = file.regular ? file.identity.size : 0;
      summary.total_bytes += bytes; summary.file_count++;
      const category = summary.categories.find(part => part.kind === file.category)!; category.bytes += bytes; category.files++;
      let protection: Protection | undefined;
      if (file.link || !file.regular) protection = 'unsafe_link';
      else if (this.referenced(file.path, immutable)) protection = 'immutable_source';
      else if (this.referenced(file.path, recent)) protection = 'recent_upload';
      else if (this.referenced(file.path, strong) || file.category === 'pdf' && refs?.hashes.has(basename(file.path, '.pdf'))) protection = 'referenced';
      else if (busy && file.known) protection = 'active_work';
      // Orphan PDFs without a paper row still receive the same upload grace.
      else if (file.category === 'pdf' && now - Math.max(file.identity.mtime, file.identity.ctime) < 24 * HOUR) protection = 'recent_upload';
      if (protection) {
        summary.protected_bytes += bytes;
        const item = protectedReasons.get(protection) ?? { code: protection, bytes: 0, files: 0 }; item.bytes += bytes; item.files++; protectedReasons.set(protection, item);
      } else if (!file.known || !complete || referenceError) summary.unknown_bytes += bytes;
      else {
        const owner = pathOwner.get(file.path), group = owner ? groups.get(find(owner)) : undefined;
        const key = group ? 'upload:' + group.map(paper => paper.id).sort().join(',') : `${file.kind}:${dirname(file.path) === this.roots()[4] ? 'native' : file.owner}:${file.kind === 'orphan_pdf' ? file.path : ''}`;
        let plan = candidateMap.get(key);
        if (!plan) {
          const name = group ? group.map(paper => paper.title).join(' / ') : `${file.kind === 'orphan_pdf' ? 'PDF ' : ''}${file.owner.slice(0, 90)}`;
          const date = group ? Math.max(...group.map(paper => dates.get(paper.id)!)) : NaN;
          plan = { value: { id: 'storage-' + sha(key).slice(0, 32), kind: group ? 'unused_upload' : file.kind, name, bytes: 0, files: 0,
            paper_ids: group?.map(paper => paper.id).sort() ?? [], ...(Number.isFinite(date) ? { last_uploaded_at: new Date(date).toISOString() } : {}),
            detail: group ? 'unused_upload_and_unreferenced_artifacts' : 'unreferenced_generated_files', parts: parts() }, files: [] };
          candidateMap.set(key, plan);
        }
        plan.files.push(file); plan.value.bytes += bytes; plan.value.files++;
        const part = plan.value.parts.find(part => part.kind === file.category)!; part.bytes += bytes; part.files++;
        summary.reclaimable_bytes += bytes;
      }
    }
    summary.protected_reasons = [...protectedReasons.values()];
    try { const disk = await statfs(this.host.directory); summary.disk = { total_bytes: Number(disk.blocks) * Number(disk.bsize), available_bytes: Number(disk.bavail) * Number(disk.bsize) }; } catch { /* Disk capacity is optional, never estimated from file sizes. */ }
    const candidates = summary.cleanup_available ? [...candidateMap.values()].sort((a, b) => a.value.id.localeCompare(b.value.id)) : [];
    return { summary, candidates, directories, referenceHash: refs?.hash ?? '',
      version: sha({ references: refs?.hash, files: files.map(file => [file.path, file.identity]), directories: Object.entries(directories).map(([path, value]) => [path, value.dev, value.ino, value.mode]), complete, referenceError, busy }) };
  }

  async summary() { return (await this.scan()).summary; }

  private prune() {
    const { db } = this.host.store, now = this.clock();
    // Interrupted executions remain explicit retry receipts, not automatic cleanup jobs.
    db.prepare("DELETE FROM workbench_storage_operations WHERE status='preview' AND expires_at<=?").run(now);
    db.prepare("DELETE FROM workbench_storage_operations WHERE status='complete' AND created_at<?").run(now - 7 * 24 * HOUR);
    for (const [status, limit] of [['preview', MAX_PREVIEWS], ['complete', MAX_RECEIPTS], ['executing', MAX_RECEIPTS]] as const)
      db.prepare(`DELETE FROM workbench_storage_operations WHERE id IN (SELECT id FROM workbench_storage_operations WHERE status=? ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET ?)`)
        .run(status, limit);
  }

  async preview(body: unknown): Promise<WorkbenchStoragePreview> {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new ContractError('invalid_storage_request');
    const scan = await this.scan(), now = this.clock();
    const preview: WorkbenchStoragePreview = { schema_version: 't1-storage-preview-1', summary: scan.summary, preview_id: 'storage-preview-' + randomUUID(),
      version: scan.version, created_at: new Date(now).toISOString(), expires_at: new Date(now + PREVIEW_MS).toISOString(), candidates: scan.candidates.map(plan => plan.value) };
    const payload: StoredPlan = { preview, candidates: scan.candidates, directories: scan.directories, referenceHash: scan.referenceHash };
    this.host.store.atomic(() => {
      this.host.store.db.prepare('INSERT INTO workbench_storage_operations VALUES(?,?,?,?,?)').run(preview.preview_id, now, now + PREVIEW_MS, 'preview', JSON.stringify(payload));
      this.prune();
    });
    return preview;
  }

  private input(body: unknown): WorkbenchStorageCleanupInput {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'candidate_ids,preview_id,version') throw new ContractError('invalid_storage_request');
    const value = body as WorkbenchStorageCleanupInput;
    if (typeof value.preview_id !== 'string' || !new RegExp(`^storage-preview-${uuid}$`, 'u').test(value.preview_id) || typeof value.version !== 'string' || !/^[a-f0-9]{64}$/u.test(value.version)) throw new ContractError('invalid_storage_request');
    if (!Array.isArray(value.candidate_ids) || !value.candidate_ids.length || value.candidate_ids.length > 10_000 || value.candidate_ids.some(id => typeof id !== 'string' || !/^storage-[a-f0-9]{32}$/u.test(id))
      || new Set(value.candidate_ids).size !== value.candidate_ids.length) throw new ContractError('invalid_storage_selection');
    return { ...value, candidate_ids: [...value.candidate_ids].sort() };
  }

  /** Walk parent descriptors from '/' with O_NOFOLLOW. The final unlink is relative
   * to the checked parent descriptor, so replacing a pathname cannot redirect it. */
  private remove(file: OwnedFile, directories: Record<string, Identity>): 'removed' | 'already_missing' {
    const path = resolve(file.path), root = this.roots().find(root => inside(root, path) && root !== path);
    if (!root || !inside(this.host.codeRoot, root)) throw new ContractError('storage_file_changed');
    const components = dirname(path).split(sep).filter(Boolean); let descriptor = openSync(sep, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), current: string = sep;
    try {
      const rootIdentity = directories[sep]; if (!rootIdentity || !sameDirectory(identity(fstatSync(descriptor)), rootIdentity)) throw new ContractError('storage_file_changed');
      for (const component of components) {
        current = resolve(current, component);
        const expected = directories[current]; if (!expected) throw new ContractError('storage_file_changed');
        const next = openSync(`/proc/self/fd/${descriptor}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        closeSync(descriptor); descriptor = next;
        if (!sameDirectory(identity(fstatSync(descriptor)), expected)) throw new ContractError('storage_file_changed');
      }
      const target = `/proc/self/fd/${descriptor}/${basename(path)}`;
      let value;
      try { value = lstatSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'already_missing'; throw error; }
      if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1 || !sameFile(identity(value), file.identity)) throw new ContractError('storage_file_changed');
      unlinkSync(target); return 'removed';
    } finally { closeSync(descriptor); }
  }

  async cleanup(body: unknown): Promise<WorkbenchStorageCleanupResult> {
    const input = this.input(body), stored = this.host.store.db.prepare('SELECT status,expires_at,payload_json FROM workbench_storage_operations WHERE id=?').get(input.preview_id);
    if (!stored) throw new ContractError('storage_preview_expired');
    const plan = JSON.parse(stored.payload_json as string) as StoredPlan;
    if (input.version !== plan.preview.version) throw new ContractError('storage_preview_stale');
    if (plan.selection && JSON.stringify(plan.selection) !== JSON.stringify(input.candidate_ids)) throw new ContractError('storage_selection_conflict');
    if (stored.status === 'complete' && plan.receipt) return { ...plan.receipt, already_executed: true, summary: await this.summary() };
    if (stored.status === 'preview' && Number(stored.expires_at) <= this.clock()) throw new ContractError('storage_preview_expired');
    if (input.candidate_ids.some(id => !plan.candidates.some(candidate => candidate.value.id === id))) throw new ContractError('invalid_storage_selection');
    return this.host.exclusive(async () => {
      this.cleaning = true;
      try {
        if (stored.status === 'preview') {
          const fresh = await this.scan(true);
          if (!fresh.summary.cleanup_available) throw new ContractError(fresh.summary.unavailable_reason ?? 'storage_preview_stale');
          if (fresh.version !== input.version) throw new ContractError('storage_preview_stale');
          this.host.store.atomic(() => {
            if (this.host.busy() || this.references().hash !== plan.referenceHash) throw new ContractError('storage_preview_stale');
            const selected = plan.candidates.filter(candidate => input.candidate_ids.includes(candidate.value.id));
            plan.selection = input.candidate_ids; plan.removed_paper_ids = selected.flatMap(candidate => candidate.value.paper_ids); plan.results = []; plan.done_files = [];
            // Commit logical removal and the recovery plan before touching any bytes.
            // A crash leaves unreferenced files; it cannot leave a live paper pointing at deleted bytes.
            for (const id of plan.removed_paper_ids) {
              this.host.store.db.prepare('DELETE FROM workbench_papers WHERE id=?').run(id);
              this.host.store.db.prepare('INSERT INTO workbench_deleted_sources VALUES(?,?) ON CONFLICT(paper_id) DO NOTHING').run(id, new Date(this.clock()).toISOString());
            }
            this.save(input.preview_id, 'executing', plan);
          });
          this.host.papersRemoved(plan.removed_paper_ids!);
        }
        const done = new Set(plan.done_files), results = plan.results ?? [];
        for (const candidate of plan.candidates.filter(candidate => input.candidate_ids.includes(candidate.value.id))) {
          if (results.some(result => result.id === candidate.value.id)) continue;
          const result: WorkbenchStorageCleanupResult['results'][number] = { id: candidate.value.id, status: 'already_missing', removed_bytes: 0, removed_files: 0 };
          this.host.store.atomic(() => {
            let refs: References | undefined;
            try { refs = this.references(); } catch { result.status = 'protected'; result.error = 'storage_reference_changed'; }
            for (const file of candidate.files) {
              if (done.has(file.path)) continue;
              if (!refs || this.host.busy() || this.referenced(file.path, refs.all) || file.category === 'pdf' && refs.allHashes.has(basename(file.path, '.pdf'))) {
                result.status = 'protected'; result.error = 'storage_reference_changed'; continue;
              }
              try {
                if (this.remove(file, plan.directories) === 'removed') { result.removed_bytes += file.identity.size; result.removed_files++; }
                done.add(file.path);
              } catch (error) {
                result.status = 'failed'; result.error = error instanceof ContractError ? error.code : 'storage_remove_failed';
              }
            }
            if (result.status !== 'failed' && result.status !== 'protected' && result.removed_files) result.status = 'removed';
            results.push(result); plan.results = results; plan.done_files = [...done]; this.save(input.preview_id, 'executing', plan);
          });
        }
        const receipt: Omit<WorkbenchStorageCleanupResult, 'summary'> = { schema_version: 't1-storage-cleanup-1', preview_id: input.preview_id,
          status: results.some(result => result.status === 'failed' || result.status === 'protected') ? 'partial' : 'complete', already_executed: false,
          removed_bytes: results.reduce((total, result) => total + result.removed_bytes, 0), removed_files: results.reduce((total, result) => total + result.removed_files, 0),
          removed_paper_ids: plan.removed_paper_ids ?? [], results };
        plan.receipt = receipt;
        // Completed receipts need no path manifest. Keep bounded idempotency without
        // retaining a second inventory of every previously scanned file.
        const completed: StoredPlan = { ...plan, preview: { ...plan.preview, candidates: [] }, candidates: [], directories: {}, referenceHash: '', done_files: [] };
        this.host.store.atomic(() => { this.save(input.preview_id, 'complete', completed); this.prune(); });
        return { ...receipt, summary: (await this.scan(true)).summary };
      } finally { this.cleaning = false; }
    });
  }

  private save(id: string, status: string, plan: StoredPlan) {
    this.host.store.db.prepare('UPDATE workbench_storage_operations SET status=?,payload_json=? WHERE id=?').run(status, JSON.stringify(plan), id);
  }
}
