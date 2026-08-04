import { request } from '@/api/client';

export interface LinkCardRule {
  id: number;
  hostname: string;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface LinkCardRuleInput {
  hostname: string;
  note?: string;
}

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
