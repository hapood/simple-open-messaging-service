import { request } from '@/api/client';

export interface LinkCardRule {
  id: number;
  matchUrl: string;
  hostname: string;
  displayName: string;
  includeSubdomains: boolean;
  enabled: boolean;
  priority: number;
  faviconUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export type LinkCardRuleInput = Pick<
  LinkCardRule,
  'matchUrl' | 'displayName' | 'includeSubdomains' | 'enabled' | 'priority'
>;

export function listLinkCardRules(): Promise<LinkCardRule[]> {
  return request<LinkCardRule[]>('/admin/link-card-rules');
}

export function createLinkCardRule(
  input: LinkCardRuleInput,
): Promise<LinkCardRule> {
  return request<LinkCardRule>('/admin/link-card-rules/create', input);
}

export function updateLinkCardRule(
  id: number,
  input: LinkCardRuleInput,
): Promise<LinkCardRule> {
  return request<LinkCardRule>(`/admin/link-card-rules/${id}/update`, input);
}

export function deleteLinkCardRule(id: number): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/admin/link-card-rules/${id}/delete`);
}
