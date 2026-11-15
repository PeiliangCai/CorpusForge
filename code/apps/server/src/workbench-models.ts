import { createHash } from 'node:crypto';
import { ContractError } from '@t1/contracts';
import type { ExtractionStore } from '@t1/agent';
import type { WorkbenchModelProfile, WorkbenchModelProfileInput } from '../../../packages/contracts/src/workbench.js';

export function modelProfile(provider: string, input: WorkbenchModelProfileInput, source: WorkbenchModelProfile['configuration_source']): WorkbenchModelProfile {
  const fields = { provider, model_id: input.model_id, api: input.api, reasoning_effort: input.reasoning_effort,
    context_window: input.context_window, max_output_tokens: input.max_output_tokens };
  // The original server configuration has a separate identity: a manually added
  // entry with the same model name must never inherit its approved exact aliases.
  const profile_id = 'model-' + createHash('sha256').update(JSON.stringify({ ...fields, configuration_source: source })).digest('hex').slice(0, 32);
  return { profile_id, ...fields, configuration_source: source };
}

/** Profiles are append-only. A new configuration never rewrites an admitted run. */
export class WorkbenchModelsStore {
  constructor(private readonly store: ExtractionStore, readonly initial: WorkbenchModelProfile) {
    store.db.exec('CREATE TABLE IF NOT EXISTS workbench_model_profiles(id TEXT PRIMARY KEY,payload_json TEXT NOT NULL)');
    this.save(initial);
  }
  private save(profile: WorkbenchModelProfile) {
    this.store.db.prepare('INSERT OR IGNORE INTO workbench_model_profiles VALUES(?,?)').run(profile.profile_id, JSON.stringify(profile));
    return this.get(profile.profile_id);
  }
  list() {
    const profiles = this.store.db.prepare('SELECT payload_json FROM workbench_model_profiles ORDER BY rowid').all()
      .map(row => JSON.parse(row.payload_json as string) as WorkbenchModelProfile).filter(profile => profile.provider === this.initial.provider);
    return { provider: this.initial.provider, default_profile_id: this.initial.profile_id, profiles };
  }
  get(id: string) {
    if (typeof id !== 'string' || !/^model-[a-f0-9]{32}$/u.test(id)) throw new ContractError('invalid_model_profile_id');
    const row = this.store.db.prepare('SELECT payload_json FROM workbench_model_profiles WHERE id=?').get(id);
    if (!row) throw new ContractError('model_profile_not_found');
    const profile = JSON.parse(row.payload_json as string) as WorkbenchModelProfile;
    if (profile.provider !== this.initial.provider) throw new ContractError('model_profile_not_found');
    return structuredClone(profile);
  }
  add(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('invalid_model_profile');
    const input = value as Record<string, unknown>, keys = ['model_id', 'api', 'reasoning_effort', 'context_window', 'max_output_tokens'];
    if (Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key)) ||
      typeof input.model_id !== 'string' || input.model_id.length > 160 || !/^[a-zA-Z0-9_./:@+-]+$/u.test(input.model_id) ||
      !['openai-responses', 'openai-completions'].includes(input.api as string) || !['medium', 'none'].includes(input.reasoning_effort as string) ||
      !Number.isSafeInteger(input.context_window) || (input.context_window as number) < 4096 || (input.context_window as number) > 2_000_000 ||
      !Number.isSafeInteger(input.max_output_tokens) || (input.max_output_tokens as number) < 256 || (input.max_output_tokens as number) > 8192 ||
      (input.max_output_tokens as number) >= (input.context_window as number)) throw new ContractError('invalid_model_profile');
    const profile = modelProfile(this.initial.provider, input as unknown as WorkbenchModelProfileInput, 'user'), profiles = this.list().profiles;
    if (profiles.some(existing => existing.profile_id === profile.profile_id)) return this.get(profile.profile_id);
    if (profiles.length >= 100) throw new ContractError('model_profile_limit');
    return this.save(profile);
  }
}
