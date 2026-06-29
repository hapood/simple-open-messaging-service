import { Directive, ElementRef, Input, OnDestroy, OnInit, inject } from '@angular/core';
import { LayoutService } from '../services/layout.service';

/**
 * 弹窗"首次最佳高度 + 锁定"机制（仅 desktop）。
 *
 * 背景：所有 dlg 共用 `.popup-com-wrapper.desktop`（height:auto; max-height:80vh;
 * overflow:auto）。容器 height:auto 时，dlg 内部 `flex:1 + overflow-y:auto` 的列表
 * 失去高度约束 → 内容一路撑高直到撞 80vh，滚动条跑到外层 wrapper、高度随条数忽高忽低，
 * 显得廉价。本指令让 dlg 在首次内容稳定后锁定一个最佳高度，之后内部列表自行滚动。
 *
 * 工作方式（zoneless 友好：全程只读写原生 DOM，不依赖变更检测）：
 *  - ResizeObserver 观察 host，感知异步内容渲染完成（无需各 dlg 上报就绪信号）。
 *  - 每次尺寸变化重排一个 settleMs 防抖；静止 settleMs 后视为稳定。
 *  - 稳定时【只读】host.scrollHeight 取内容自然高（wrapper 已 overflow:auto，
 *    scrollHeight 即无裁剪内容高；不在 RO 回调里 mutate style，避免反馈循环/闪烁），
 *    clamp 到 [min,max]，【只写一次】host.style.height 并锁定、断开 RO。
 *  - 锁定后 host 有了确定 px 高度，内部 flex:1 滚动区正常在内部滚动。
 *    inline style 特异性高于各 dlg 的 height:100% / min-height:100%，无需 !important。
 *
 * mobile/tablet（非 .desktop wrapper，全屏 100%/100%）整体 no-op。
 */
export interface FitDialogOptions {
  /** px 下限；默认 200。防空列表时弹窗过矮显廉价。 */
  minHeight?: number;
  /** px 上限；默认 0.8 * window.innerHeight（对齐 wrapper 的 80vh）。 */
  maxHeight?: number;
  /** 内容静止多久后锁定；默认 180。异步数据在子组件的 dlg 调大（如 600）。 */
  settleMs?: number;
  /**
   * 可选：互斥内容 pane 的选择器（如 '.tab-pane'）。设置后，锁定时逐个临时取消
   * [hidden] 读各 pane 自然高取最大，再恢复。要求 pane 异步数据在锁定时已就绪
   * （调用方负责）。多数 dlg 不用——直接测当前可见内容的自然高即可。
   */
  paneSelector?: string;
}

@Directive({ selector: '[appFitDialog]' })
export class FitDialogDirective implements OnInit, OnDestroy {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly layout = inject(LayoutService);

  private ro?: ResizeObserver;
  private settleTimer?: ReturnType<typeof setTimeout>;
  private locked = false;

  /** 绑定 `[appFitDialog]="opts"`；裸用 `[appFitDialog]` 时为 '' → 全默认值。 */
  @Input('appFitDialog') opts: FitDialogOptions | '' = '';

  ngOnInit(): void {
    if (!this.layout.isDesktop()) return; // mobile/tablet 全屏，无需 fit
    const el = this.host.nativeElement;
    // host（app-xxx / 根 div）默认 display:inline 会破坏 scrollHeight 与 flex 布局；
    // 仅当确为 inline 系时抬到 block，绝不破坏已有的 flex 列。
    const disp = getComputedStyle(el).display;
    if (disp === 'inline' || disp === 'inline-block') el.style.display = 'block';
    // 打开即设 minHeight 下限，避免「先 auto 撑小 → settle 后跳到锁定值」的可见跳变；
    // settle 后 lockNow 会按内容自然高 clamp 出最终值（多数情况仍 = minHeight，不再变）。
    el.style.height = this.minHeight() + 'px';
    // 临时诊断：校准各 dlg 的 minHeight 后删除。
    console.log('[appFitDialog] init host=%s minHeight=%d', el.tagName, this.minHeight());
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(el);
  }

  private onResize(): void {
    if (this.locked) return; // 锁定后这一次回写触发的 RO 被忽略
    clearTimeout(this.settleTimer!);
    this.settleTimer = setTimeout(() => this.lockNow(), this.settleMs());
  }

  private lockNow(): void {
    if (this.locked) return;
    this.locked = true;
    this.ro?.disconnect();
    const el = this.host.nativeElement;
    const natural = this.measure();
    const target = Math.max(this.minHeight(), Math.min(natural, this.maxHeight()));
    const px = target + 'px';
    // 临时诊断：natural 是内容真实自然高，据此校准 minHeight（校准后删除）。
    console.log('[appFitDialog] lock natural=%d target=%d prev=%s', natural, target, el.style.height);
    if (el.style.height !== px) el.style.height = px; // 只写一次，盖过 height:100%
  }

  /** 内容自然高：paneSelector 时取各 pane 最大，否则 host.scrollHeight（只读）。 */
  private measure(): number {
    const el = this.host.nativeElement;
    const sel = this.options.paneSelector;
    // 临时解除高度约束读「内容自然高」。仅在 lockNow（RO 已断开）一次性执行，
    // 同步恢复，浏览器不 paint 中间态——故不会闪烁、也不触发 RO 反馈。
    const prev = el.style.height;
    el.style.height = 'auto';
    try {
      if (!sel) return el.scrollHeight;
      const panes = Array.from(el.querySelectorAll(sel)) as unknown as HTMLElement[];
      if (panes.length === 0) return el.scrollHeight;
      // 逐个临时显现 pane 读 host 自然高，取最大后恢复。
      let max = 0;
      for (const p of panes) {
        const wasHidden = p.hidden;
        if (wasHidden) p.hidden = false;
        max = Math.max(max, el.scrollHeight);
        if (wasHidden) p.hidden = true;
      }
      return max;
    } finally {
      el.style.height = prev;
    }
  }

  /** opts 为 ''（裸用）时归一化为空对象，避免 `'' && x ?? d` 返回 '' 的陷阱。 */
  private get options(): FitDialogOptions {
    return typeof this.opts === 'object' && this.opts !== null ? this.opts : {};
  }
  private minHeight(): number {
    return this.options.minHeight ?? 200;
  }
  private maxHeight(): number {
    return this.options.maxHeight ?? Math.round(0.8 * window.innerHeight);
  }
  private settleMs(): number {
    return this.options.settleMs ?? 180;
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
    clearTimeout(this.settleTimer!);
  }
}
