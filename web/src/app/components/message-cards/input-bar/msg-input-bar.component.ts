import {
  Component,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MsgService } from '../../../services/message.service';

const EMOJIS = [
  '😀', '😂', '🥰', '😎', '🤔', '😢', '😡', '👍',
  '🙏', '🎉', '❤️', '🔥', '✨', '🌟', '💯', '🆗',
];

/**
 * WhatsApp 式消息输入栏（emoji + auto-grow textarea + 附件 + 容器外发送键）。
 *
 * 对接真实 API：
 *  - 文本：msgService.sendMessage(contentType:'PURE_TEXT')。
 *  - 图片：createImageBitmap 读宽高 → uploadMedia → sendMessage(contentType:'IMAGE',
 *    content=JSON{url,w,h})。多图连续发多条 IMAGE（后端逐条存），前端 toItems 合并相册显示。
 *
 * 软键盘避让：靠 viewport meta 的 interactive-widget=resizes-content + flex 布局（不用
 * visualViewport JS——三星含地址栏会撑高页面，见 mobile-keyboard-viewport-strategy 记忆）。
 *
 * 后期补：完整 emoji 库/分类、引用回复/@提及、typing 状态、富文本。
 */
@Component({
  selector: 'app-msg-input-bar',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './msg-input-bar.component.html',
  styleUrl: './msg-input-bar.component.scss',
})
export class MsgInputBarComponent {
  readonly userThreadId = input<number>();
  readonly onAfterSent = output<void>();

  private readonly msgService = inject(MsgService);
  private readonly draftInput =
    viewChild<ElementRef<HTMLTextAreaElement>>('draftInput');
  private readonly attachInput = viewChild<ElementRef<HTMLInputElement>>('attachInput');

  readonly draft = signal('');
  readonly emojiOpen = signal(false);
  readonly sending = signal(false);

  readonly EMOJIS = EMOJIS;

  onDraftChange(v: string) {
    this.draft.set(v);
    this.autoGrow();
  }

  /** Enter 发送、Shift+Enter 换行。 */
  onInputKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.sendText();
    }
  }

  toggleEmoji() {
    this.emojiOpen.update((v) => !v);
  }

  /** emoji 插入光标处（无光标则追加），恢复光标到插入点后。 */
  insertEmoji(e: string) {
    const ta = this.draftInput()?.nativeElement;
    const cur = this.draft();
    const start = ta?.selectionStart ?? cur.length;
    const end = ta?.selectionEnd ?? cur.length;
    this.draft.set(cur.slice(0, start) + e + cur.slice(end));
    this.autoGrow();
    // ngModel 同步 textarea.value 是异步（CD 后），光标恢复延到 microtask。
    Promise.resolve().then(() => {
      const t = this.draftInput()?.nativeElement;
      if (t) {
        t.focus();
        const pos = start + e.length;
        t.setSelectionRange(pos, pos);
      }
    });
  }

  /** 发送键：有文字→发文字；无文字→唤起附件选图（WhatsApp 相机入口同义）。 */
  onSendClick() {
    if (this.draft().trim()) this.sendText();
    else this.onAttachClick();
  }

  onAttachClick() {
    this.attachInput()?.nativeElement.click();
  }

  onAttachChange(e: Event) {
    const input = e.target as HTMLInputElement;
    void this.sendImage(input.files);
    input.value = ''; // 清空，允许重复选同一文件
  }

  /** textarea auto-grow：1~6 行自适应撑高，超过内部滚动。 */
  private autoGrow() {
    const ta = this.draftInput()?.nativeElement;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
    }
  }

  sendText() {
    const tid = this.userThreadId();
    const text = this.draft().trim();
    if (!tid || !text || this.sending()) return;
    this.sending.set(true);
    this.msgService
      .sendMessage({ userThreadId: tid, content: text, contentType: 'PURE_TEXT' })
      .subscribe({
        next: (res) => {
          this.sending.set(false);
          if (res.code === 0) {
            this.draft.set('');
            this.autoGrow();
            this.onAfterSent.emit();
          }
        },
        error: () => this.sending.set(false),
      });
  }

  /** 逐张上传图片并发送 IMAGE 消息（多图连续发，前端合并相册显示）。 */
  async sendImage(files: FileList | null) {
    const tid = this.userThreadId();
    if (!tid || !files) return;
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
    for (const f of list) {
      try {
        const bmp = await createImageBitmap(f);
        const w = bmp.width;
        const h = bmp.height;
        bmp.close();
        const up = await firstValueFrom(this.msgService.uploadMedia(f, w, h));
        if (up.code !== 0 || !up.data) continue;
        await firstValueFrom(
          this.msgService.sendMessage({
            userThreadId: tid,
            content: JSON.stringify({ url: up.data.url, w, h }),
            contentType: 'IMAGE',
          }),
        );
        this.onAfterSent.emit();
      } catch (e) {
        console.error('send image failed', e);
      }
    }
  }
}
