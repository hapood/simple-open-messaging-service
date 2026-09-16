import { request } from '@/api/client';

export interface MessageTarget {
  threadId: number;
  seq: number;
}

interface MessageReportListItem extends MessageTarget {
  isDeleted: boolean;
  createdAt: number;
  updatedAt: number;
  creator: { account: string; name: string; domain: string };
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
  isDeleted?: boolean;
}): Promise<MessageReportListResult> {
  return request('/admin/message-reports', params);
}

export function dismissMessageReport(params: MessageTarget): Promise<unknown> {
  return request('/admin/message-reports/delete', params);
}

function deleteMessage(
  params: MessageTarget,
): Promise<{ threadId: number; messageSeq: number; deletionSeq: number }> {
  return request('/admin/messages/delete', params);
}

/** Each selection is an independent single-message request. Keep failed targets
 * so the UI can retry them without losing successful submissions. */
export async function deleteSelectedMessages(targets: MessageTarget[]) {
  const failed: MessageTarget[] = [];
  for (const target of targets) {
    try {
      await deleteMessage({
        threadId: target.threadId,
        seq: target.seq,
      });
    } catch {
      failed.push(target);
    }
  }
  return { deleted: targets.length - failed.length, failed };
}
