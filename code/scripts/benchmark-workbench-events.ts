import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { cpus } from 'node:os';
import { ExtractionStore } from '@t1/agent';
import { WorkbenchWorkflow } from '../apps/server/src/workflow.js';

const argument = (key: string) => process.argv[process.argv.indexOf(key) + 1];
const id = argument('--run-id'), output = argument('--output');
if (!process.argv.includes('--run-id') || !id || !/^[a-zA-Z0-9:_-]{1,160}$/u.test(id) || !process.argv.includes('--output') || !output) throw new Error('explicit_run_and_output_required');
const live = new DatabaseSync(resolve('runtime-data/t1.sqlite'), { readOnly: true });
const isolated = new ExtractionStore(':memory:');
const workflow = new WorkbenchWorkflow(isolated, { sources: false });
try {
  const run = live.prepare('SELECT * FROM s4_runs WHERE id=?').get(id)!;
  const row = live.prepare('SELECT * FROM workbench_runs WHERE id=?').get(id)!;
  if (!run || !row) throw new Error('run_not_found');
  const paper = live.prepare('SELECT * FROM workbench_papers WHERE id=?').get(row.paper_id as string)!;
  const events = live.prepare('SELECT * FROM s4_events WHERE run_id=? ORDER BY seq').all(id);
  isolated.db.prepare('INSERT INTO s4_runs VALUES(?,?,?,?)').run(id, run.input_json as string, run.state as string, run.metadata_json as string);
  isolated.db.prepare('INSERT INTO workbench_papers VALUES(?,?)').run(row.paper_id as string, paper.payload_json as string);
  isolated.db.prepare('INSERT INTO workbench_runs VALUES(?,?,?)').run(id, row.paper_id as string, row.payload_json as string);
  for (const event of events) isolated.db.prepare('INSERT INTO s4_events VALUES(?,?,?)').run(id, Number(event.seq), event.payload_json as string);
  const previous = (after: number) => {
    const payload = isolated.db.prepare('SELECT payload_json FROM workbench_runs WHERE id=?').get(id)!;
    JSON.parse(payload.payload_json as string); // Original this.run(id) decoded the complete source snapshot each poll.
    return isolated.events(id).filter(e => e.seq > after);
  };
  const current = (after: number) => workflow.events(id, after);
  const maximum = Number(events.at(-1)?.seq ?? 0), checks = [0, Math.max(0, maximum - 5), maximum, maximum + 1];
  for (const cursor of checks) assert.deepEqual(current(cursor), previous(cursor));
  const measure = (fn: (after: number) => unknown, after: number) => {
    for (let n = 0; n < 5; n++) fn(after);
    const cpu = process.cpuUsage(), samples: number[] = [];
    for (let n = 0; n < 50; n++) { const start = performance.now(); fn(after); samples.push(performance.now() - start); }
    const used = process.cpuUsage(cpu); samples.sort((a, b) => a - b);
    return { iterations: samples.length, mean_ms: samples.reduce((a, b) => a + b, 0) / samples.length,
      median_ms: samples[Math.floor(samples.length / 2)]!, p95_ms: samples[Math.ceil(samples.length * .95) - 1]!,
      cpu_user_ms: used.user / 1000, cpu_system_ms: used.system / 1000 };
  };
  const results = [maximum, Math.max(0, maximum - 5)].map(cursor => {
    const before = measure(previous, cursor), after = measure(current, cursor);
    return { cursor, returned_events: current(cursor).length, before, after, mean_ratio_before_over_after: before.mean_ms / after.mean_ms };
  });
  const report = { schema_version: 'workbench-event-query-benchmark-1', measured_at: new Date().toISOString(),
    scope: 'Local synchronous event-poll function on exposed real-task snapshots copied to an isolated in-memory SQLite database; no full-extraction speed claim.',
    production_database_opened_read_only: true, production_business_writes: 0, extra_paid_model_calls: 0,
    run_id: id, source_snapshot_bytes: Buffer.byteLength(row.payload_json as string), persisted_events: events.length,
    event_payload_bytes: events.reduce((n, e) => n + Buffer.byteLength(e.payload_json as string), 0),
    environment: { node: process.version, platform: process.platform, architecture: process.arch, cpu: cpus()[0]?.model, logical_cpus: cpus().length },
    equivalence_cursors: checks, exact_event_equivalence: true, results,
    limitation: 'Process scheduling, concurrent user activity, HTTP serialization and model/provider waits are outside this microbenchmark.' };
  await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ output, exact_event_equivalence: true, results }) + '\n');
} finally { live.close(); isolated.close(); }
