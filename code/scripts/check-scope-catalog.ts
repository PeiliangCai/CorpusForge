import { readScopeCatalog, SCOPE_CATALOG_FILE, ScopeCatalogConfigError } from '../apps/server/src/catalog-config.js';

try {
  if (process.argv.length !== 2) throw new Error('scope_catalog_check_does_not_accept_paths');
  const snapshot = readScopeCatalog();
  process.stdout.write(JSON.stringify({ valid: true, file: SCOPE_CATALOG_FILE, sha256: snapshot.sha256,
    byte_length: snapshot.byte_length, status: snapshot.catalog.status, medical_review_approved: false,
    cancers: snapshot.config.cancers.length, image_types: snapshot.config.image_types.length }, null, 2) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ valid: false, file: SCOPE_CATALOG_FILE,
    error: error instanceof Error ? error.message : 'scope_catalog_check_failed',
    ...(error instanceof ScopeCatalogConfigError ? { issues: error.issues } : {}) }, null, 2) + '\n');
  process.exitCode = 1;
}
