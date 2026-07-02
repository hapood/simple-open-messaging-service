import { Component, computed, input, output } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../../user-avatar/user-avatar.component';

/** Display category derived from mimeType (drives the icon tint). Purely presentational — mirrors the
 *  backend FILE_MIME_EXT set without depending on it. */
type FileCategory =
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slides'
  | 'archive'
  | 'text'
  | 'file';

function categorize(mimeType: string): FileCategory {
  if (mimeType === 'application/pdf') return 'pdf';
  if (
    mimeType === 'application/msword' ||
    mimeType === 'application/rtf' ||
    mimeType.startsWith(
      'application/vnd.openxmlformats-officedocument.wordprocessingml',
    )
  ) {
    return 'doc';
  }
  if (
    mimeType === 'application/vnd.ms-excel' ||
    mimeType.startsWith(
      'application/vnd.openxmlformats-officedocument.spreadsheetml',
    )
  ) {
    return 'sheet';
  }
  if (
    mimeType === 'application/vnd.ms-powerpoint' ||
    mimeType.startsWith(
      'application/vnd.openxmlformats-officedocument.presentationml',
    )
  ) {
    return 'slides';
  }
  if (
    mimeType === 'application/zip' ||
    mimeType === 'application/x-zip-compressed' ||
    mimeType === 'application/x-tar' ||
    mimeType === 'application/gzip' ||
    mimeType === 'application/x-gzip' ||
    mimeType === 'application/x-7z-compressed' ||
    mimeType === 'application/x-rar-compressed'
  ) {
    return 'archive';
  }
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml'
  ) {
    return 'text';
  }
  return 'file';
}

/** Human-readable byte size (B / KB / MB / GB). Empty for 0/unknown. */
function formatBytes(n: number): string {
  if (!n || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * FILE message row: a compact, fixed-width bubble with a type-tinted icon, the filename, the size, and a
 * download glyph. The icon+meta area is an <a download> so the whole card downloads the file; the status
 * tick + time sit outside the anchor. Follows the 5 _row-base contracts (border-box height, self-contained
 * width via a fixed px width + max-width:100%, host autonomy).
 *
 * When file.url is empty (an optimistic send before any URL exists, e.g. the playground mock), the content
 * renders as a non-link row so a click does not navigate.
 */
@Component({
  selector: 'app-msg-file-row',
  standalone: true,
  imports: [DateRowComponent, UserAvatarComponent, NgTemplateOutlet],
  templateUrl: './file-row.component.html',
  styleUrl: './file-row.component.scss',
})
export class FileRowComponent {
  readonly UserAvatarType = UserAvatarType;
  readonly data = input.required<ChatMsgData>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  readonly dateLabel = input<string | null>(null);

  readonly side = computed(() => (this.data().isSelf ? 'self' : 'other'));
  readonly showAvatar = computed(() => this.isShowHead());
  readonly pos = computed(() => (this.isShowHead() ? 'head' : 'body'));
  readonly showName = computed(() => this.isShowHead() && !this.data().isSelf);
  readonly statusTick = computed(() => this.data().isSelf && !!this.data().status);
  readonly isSending = computed(
    () => this.data().isSelf && this.data().status === 'sending',
  );
  readonly isFailed = computed(
    () => this.data().isSelf && this.data().status === 'failed',
  );
  readonly retry = output<string>();

  readonly file = computed(() => this.data().file);
  readonly category = computed<FileCategory>(() =>
    categorize(this.file()?.mimeType ?? ''),
  );
  /** Extension badge (uppercased), derived from the trusted filename the server sanitized. */
  readonly ext = computed(() => {
    const name = this.file()?.name ?? '';
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i + 1).toUpperCase() : 'FILE';
  });
  readonly sizeText = computed(() => formatBytes(this.file()?.size ?? 0));
}
