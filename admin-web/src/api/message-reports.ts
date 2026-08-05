import { request } from '@/api/client';

export type MessageReportStatus = 'PENDING' | 'UPHELD' | 'REJECTED';

export interface MessageReportListItem {
  id: string;
  status: MessageReportStatus;
  createdAt: number;
  reviewedAt: number | null;
  threadId: number;
  messageSeq: number;
  reporter: { id: number; account: string; name: string };
  creator: { id: number; account: string; name: string; domain: string };
  message: {
    id: string;
    contentType: string;
    content: string;
    createdAt: number;
    isDeleted: boolean;
    originSeq: number | null;
  };
  threadType: 'P2P' | 'GROUP';
}

export interface MessageReportListResult {
  list: MessageReportListItem[];
  total: number;
}

export function listMessageReports(params: {
  skip?: number;
  take?: number;
  status?: MessageReportStatus;
}): Promise<MessageReportListResult> {
  return request('/admin/message-reports', params);
}

export function resolveMessageReports(params: {
  reportIds: string[];
  status: 'UPHELD' | 'REJECTED';
}): Promise<unknown> {
  return request('/admin/message-reports/resolve', params);
}
