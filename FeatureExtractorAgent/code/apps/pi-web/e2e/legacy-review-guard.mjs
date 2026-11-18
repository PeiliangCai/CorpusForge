/** Old approval-UI scripts are kept as historical evidence, never the daily retention regression entry. */
export function assertLegacyReviewCapabilities(capabilities, script) {
  if (capabilities?.persisted_retention === true) throw new Error(`${script} checks the historical individual-approval UI and cannot run on the keep/exclude workbench. Use e2e/retention-workflow.mjs with an isolated test DB, or e2e/retention-readonly.mjs for ordinary read-only smoke. No browser or data action was started.`);
}

export async function requireLegacyReviewWorkflow(origin, script, fetcher = fetch) {
  const response = await fetcher(new URL('/api/t1/workbench/capabilities', origin), { method: 'GET', cache: 'no-store' });
  if (!response.ok) throw new Error(`${script}: cannot verify legacy UI capabilities (HTTP ${response.status}); refusing to start browser/data actions.`);
  assertLegacyReviewCapabilities(await response.json(), script);
}
