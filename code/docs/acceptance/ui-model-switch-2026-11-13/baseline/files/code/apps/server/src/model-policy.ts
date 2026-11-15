import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ContractError } from '@t1/contracts';
import { developmentProfile, type ModelConfig, type ResponseModelAliasPolicy } from '@t1/agent';

/** Exact returned-label choices only; this does not authenticate model weights or authorize a request. */
export function workbenchModelPolicy(config: Pick<ModelConfig, 'provider' | 'baseUrl' | 'modelId'>) {
  const profile = developmentProfile(config.modelId);
  if (config.provider !== 'agicto' || config.baseUrl !== 'https://api.agicto.cn/v1' || config.modelId !== 'gpt-6-luna') return { profile };
  const source = 'docs/acceptance/s4/selection-optimization/continuation-2026-11-03/supplier-alias-confirmation.json';
  const bytes = readFileSync(fileURLToPath(new URL('../../../' + source, import.meta.url)));
  if (createHash('sha256').update(bytes).digest('hex') !== '54289c509f5c5ce7327459e84af26763e45423b91bcd31aa271ca0c87d2490a1') throw new ContractError('confirmed_model_alias_evidence_changed');
  const value = JSON.parse(bytes.toString());
  const expected = [{ requested_model: 'gpt-6-luna', response_model: 'igpt-6-luna' }, { requested_model: 'igpt-6-luna', response_model: 'gpt-6-luna' }];
  if (value.requested_model !== config.modelId || value.reasoning_effort !== profile.reasoning_effort || value.wildcard_or_prefix_stripping_allowed !== false || JSON.stringify(value.exact_pairs) !== JSON.stringify(expected)) throw new ContractError('confirmed_model_alias_evidence_invalid');
  const choicePath = 'config/workbench-response-model-policy.json';
  const choiceBytes = readFileSync(fileURLToPath(new URL('../../../' + choicePath, import.meta.url)));
  if (createHash('sha256').update(choiceBytes).digest('hex') !== '9c261cd263921b5c949926da4448dcf10c9e971e2ed43f814015a4025ab1d9a1')
    throw new ContractError('workbench_response_model_choice_changed');
  const choice = JSON.parse(choiceBytes.toString());
  const additional = [{ requested_model: 'gpt-6-luna', response_model: 'data-zone-standard-gpt-6-luna' }];
  if (choice.schema_version !== 't1-workbench-response-model-policy-1' || choice.provider !== config.provider ||
    choice.endpoint !== config.baseUrl || choice.requested_model !== config.modelId || choice.reasoning_effort !== profile.reasoning_effort ||
    choice.prior_supplier_confirmation?.path !== source || choice.prior_supplier_confirmation?.sha256 !== createHash('sha256').update(bytes).digest('hex') ||
    choice.wildcard_or_prefix_stripping_allowed !== false || JSON.stringify(choice.additional_exact_pairs) !== JSON.stringify(additional) ||
    choice.additional_pair_authority?.basis !== 'user_or_delegated_deployment_choice' || choice.additional_pair_authority.supplier_confirmed !== false ||
    choice.additional_pair_authority.weight_identity_verified !== false || !Number.isFinite(Date.parse(choice.recorded_at)))
    throw new ContractError('workbench_response_model_choice_invalid');
  const responseModelAliasPolicy: ResponseModelAliasPolicy = { policy_id: choice.policy_id, source: 'code/' + choicePath,
    recorded_at: choice.recorded_at, exact_pairs: [...expected, ...additional] };
  return { profile, responseModelAliasPolicy };
}
