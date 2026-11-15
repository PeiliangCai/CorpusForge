/** Isolated reproduction of an identical-PDF restore recreating a deleted file. */
import fs, { access, mkdtemp, rm } from 'node:fs/promises';
import { mock } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { ExtractionStore } from '@t1/agent';
import { WorkbenchWorkflow } from '../../../apps/server/src/workflow.js';
const bytes = Buffer.from('%PDF-1.4\n% RESTORE DELETE ENGINEERING STUB\n%%EOF\n');
const directory = await mkdtemp(resolve('runtime-data/restore-delete-baseline-')), store = new ExtractionStore(resolve(directory, 'test.sqlite'));
const workflow = new WorkbenchWorkflow(store, { sources: false, directory });
let entered!: () => void, release!: () => void;
const blocked = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
let intercepted: ReturnType<typeof mock.method> | undefined;
try {
  const paper = (await workflow.upload(bytes, 'restore.pdf')).paper;
  const row = JSON.parse(store.db.prepare('SELECT payload_json FROM workbench_papers WHERE id=?').get(paper.id)!.payload_json as string);
  const path = resolve(workflow.codeRoot, row.pdf.path), write = fs.writeFile;
  intercepted = mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]) === path) { entered(); await gate; } return write(...args);
  }); syncBuiltinESMExports();
  const pending = workflow.restorePdf(paper.id, bytes); await blocked;
  const deleted = await workflow.deletePaper(paper.id); release(); const restored = await pending;
  console.log(JSON.stringify({ scenario: 'restore_write_overlaps_delete', deletion_accepted: deleted.deleted, restore_reported_success: restored.restored,
    remaining_papers: (await workflow.papers()).length, orphan_pdf_exists: await access(path).then(() => true, () => false), paid_model_calls: 0, production_write_requests: 0 }));
} finally { release?.(); intercepted?.mock.restore(); syncBuiltinESMExports(); await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
