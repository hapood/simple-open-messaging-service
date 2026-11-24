import type { FileMedia, ChatMsgData } from './chat-item';

/** Project one FILE attachment into the same resource contract as an album cell. */
export function fileMedia(data: ChatMsgData): FileMedia {
  if (data.contentType !== 'FILE' || data.file === null) {
    throw new Error('FILE message requires attachment metadata');
  }
  const file = data.file;
  return {
    kind: 'file',
    src: file.url,
    name: file.name,
    size: file.size,
    mimeType: file.mimeType,
    msgId: data.msgId,
    senderName: data.name,
    sentAt: data.createdAtMs,
  };
}
