import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import type { AlbumMedia } from '../message-cards/chat-item';
import { formatBytes, formatDuration } from '../message-cards/file-meta.util';

/** Type-specific metadata, independent of transfer and derivative state. */
@Component({
  selector: 'app-attachment-metadata',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let resource = media();
    <div class="name">{{ resource.name }}</div>
    <div class="facts">
      <span>{{ formatBytes(resource.size) }}</span>
      <span>{{ resource.mimeType }}</span>
      @switch (resource.kind) {
        @case ('image') {
          <span>{{ resource.w }} × {{ resource.h }}</span>
        }
        @case ('video') {
          <span>{{ resource.w }} × {{ resource.h }}</span>
          <span>{{ formatDuration(resource.duration) }}</span>
        }
        @case ('audio') {
          <span>{{ formatDuration(resource.duration) }}</span>
        }
      }
    </div>
    <div class="attribution">
      @if (resource.senderName !== null) {
        <span>{{ resource.senderName }}</span>
      }
      @if (resource.sentAt !== null) {
        <span>{{ resource.sentAt | date: 'medium' }}</span>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      color: white;
      text-align: center;
    }
    .name {
      max-height: 48px;
      overflow: auto;
      overflow-wrap: anywhere;
      font-size: 14px;
      line-height: 24px;
    }
    .facts,
    .attribution {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      column-gap: 12px;
      row-gap: 0;
      font-size: 12px;
      line-height: 20px;
      opacity: 0.72;
    }
    .facts {
      max-height: 40px;
      overflow: auto;
    }
    .attribution {
      max-height: 20px;
      overflow: hidden;
    }
  `,
})
export class AttachmentMetadataComponent {
  readonly media = input.required<AlbumMedia>();
  readonly formatBytes = formatBytes;
  readonly formatDuration = formatDuration;
}
