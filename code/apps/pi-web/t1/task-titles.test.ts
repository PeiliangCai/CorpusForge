import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkbenchPaper, WorkbenchRun } from '../../../packages/contracts/src/workbench';
import { originalRunFilename, taskDisplayTitle } from './task-titles';
import { groupSubmittedRuns } from './submission-groups';
const paper: WorkbenchPaper = { id: 'p', title: 'Source identity', filename: 'source.pdf', language: 'und', pages: 0, note: '', sha256: 'a'.repeat(64), output_ids: [] };
const run: WorkbenchRun = { run_id: 'r', document_id: 'p', state: 'completed', fixture: true, candidate_count: 0 };
test('independent task titles and incoming basenames do not rename the paper source', () => {
  const named = { ...run, task_title: 'Independent task', original_filename: 'incoming.pdf', submission: { kind: 'single' as const } };
  assert.equal(taskDisplayTitle(named, paper), 'Independent task'); assert.equal(originalRunFilename(named, paper), 'incoming.pdf'); assert.equal(paper.title, 'Source identity');
  assert.equal(taskDisplayTitle(run, paper), 'Source identity');
});
test('batch group name is independent of child filenames and old paper titles never become a fabricated group title', () => {
  const submission = { kind: 'batch' as const, batch_id: 'group' }, named = { ...run, task_title: 'Whole group', original_filename: 'child.pdf', submission };
  assert.equal(originalRunFilename(named, paper), 'child.pdf'); assert.equal(taskDisplayTitle(named, paper), 'Whole group · child.pdf');
  assert.equal(groupSubmittedRuns([named, { ...named, run_id: 'r2' }])[0]!.taskTitle, 'Whole group');
  const legacy = groupSubmittedRuns([{ ...run, submission }, { ...run, run_id: 'r2', submission }]); assert.equal(legacy[0]!.taskTitle, undefined); assert.equal(legacy[0]!.runs.length, 2);
  assert.equal(groupSubmittedRuns([run, { ...run, run_id: 'r2' }]).length, 2);
});
