/**
 * Playground mock 接口层。
 *
 * 把 playground 的数据生产/发送/上传收敛成「像真实后端」的调用：每次调用以「入参 / 出参」
 * 形式打到 console（便于演示与排查），不再入面板、不再记 url/延迟。
 *  - generate(count)：聊天生成器，入参只有数据量，一次性产 n 条确定性记录（seeded PRNG）。
 *  - sendMessage / uploadMedia / simulateIncoming(WS)：在稳定数据集上追加。
 *
 * 设计取舍：mock 直接产 {@link VsItem}<{@link ChatItemData}>（不绕道 Message[]+toItems）——
 * playground 不演示后端转换逻辑，重点是「请求可观测 + 虚拟滚动行为」。
 * 数据确定性：generate 用 seeded PRNG（同 count 同数据），保证「后续接口请求的稳定」。
 * 入参/出参中大载荷（万条数组 / dataURL）仅摘要，避免刷爆控制台。
 */
import type { VsItem } from '../../lib/virtual-scroll/virtual-scroller';
import type { AlbumImage, ChatItemData, ChatMsgData } from '../../components/message-cards/chat-item';

// 生产 AOT 置 ngDevMode=falsy 并据此死代码消除。守卫 mock 入参/出参 console——生产不输出。
declare const ngDevMode: boolean | null | undefined;

export interface SendMessageParams {
  content: string;
  contentType: ChatMsgData['contentType'];
  /** IMAGE：相册图片（同发送者连续图，已由前端合并为一条）。 */
  images?: AlbumImage[] | null;
}

/**
 * Mock 聊天接口：持有一份稳定数据集，generate 一次性生成，send/upload/incoming 在其上追加。
 * 每个方法模拟随机 latency（让异步流程真实）、完成后 console 打印入参/出参。
 */
export class MockChatApi {
  /** 稳定数据集（generate 写入，send/incoming 追加）。 */
  private dataset: VsItem<ChatItemData>[] = [];
  /** 自发/接收消息 id 序号（避免与 generate 的 seed-N 冲突）。 */
  private sendSeq = 0;

  /**
   * 聊天生成器：入参只有数据量 count，一次性生成 count 条确定性记录（seeded PRNG）。
   * 记一条 console（入参 count / 出参条数 + 首末 id），返回数据集供组件 setItems。
   */
  async generate(count: number): Promise<VsItem<ChatItemData>[]> {
    await delay(120 + Math.floor(Math.random() * 280));
    this.dataset = buildItems(count);
    this.log('generate', { count }, {
      条数: this.dataset.length,
      首条: this.dataset[0]?.id,
      末条: this.dataset[this.dataset.length - 1]?.id,
    });
    return this.dataset;
  }

  /** 发送一条消息（文本/图片），追加到数据集末尾；console 记入参(内容/类型/图数) + 出参(id)。 */
  async sendMessage(params: SendMessageParams): Promise<VsItem<ChatItemData>> {
    await delay(40 + Math.floor(Math.random() * 90));
    const data = this.makeMsg(1, true, params.contentType === 'IMAGE' ? '' : params.content, params.contentType, params.images ?? null);
    const item: VsItem<ChatItemData> = { id: data.msgId, data };
    this.dataset.push(item);
    this.log('send-message',
      { 类型: params.contentType, 内容: params.content, 图片数: params.images?.length ?? 0 },
      { id: data.msgId, 发送方: 'self' });
    return item;
  }

  /** 模拟上传（playground 已本地读到 dataURL + 尺寸，mock 仅回显 + 记请求）；console 记图数/尺寸。 */
  async uploadMedia(images: AlbumImage[]): Promise<AlbumImage[]> {
    await delay(80 + Math.floor(Math.random() * 160));
    this.log('upload',
      { 图片数: images.length, 尺寸: images.map(i => ({ w: i.w, h: i.h })) },
      { ok: true, 回显: images.length });
    return images;
  }

  /** 模拟对方回复（真实聊天经 WS 推送）：console 记入参(空) + 出参(id/发送方/text)。 */
  async simulateIncoming(text?: string): Promise<VsItem<ChatItemData>> {
    await delay(60 + Math.floor(Math.random() * 140));
    const phrase = text ?? PHRASES[Math.floor(Math.random() * PHRASES.length)];
    const data = this.makeMsg(2, false, phrase, 'PURE_TEXT', null);
    const item: VsItem<ChatItemData> = { id: data.msgId, data };
    this.dataset.push(item);
    this.log('ws new-message', {}, { id: data.msgId, 发送方: 'other', text: phrase });
    return item;
  }

  /** 入参/出参打到 console（不记 url/延迟）。ngDevMode 守卫 → 生产 AOT 不输出。 */
  private log(name: string, input: unknown, output: unknown): void {
    if (!ngDevMode) return;
    console.log('%c[mock] ' + name, 'color:#09f;font-weight:600', { 入参: input, 出参: output });
  }

  private makeMsg(creator: number, isSelf: boolean, text: string, contentType: ChatMsgData['contentType'], images: AlbumImage[] | null): ChatMsgData {
    const now = new Date();
    return {
      type: 'msg',
      msgId: `${isSelf ? 'mock' : 'recv'}-${this.sendSeq++}`,
      creator,
      isSelf,
      name: isSelf ? '我' : '阿黄',
      text,
      time: formatTime(now),
      contentType,
      images,
      createdAtMs: now.getTime(),
    };
  }
}

// ---------- 数据生产（确定性）----------

const PHRASES = [
  '在吗？', '虚拟滚动内核跑起来了', '你那边列表卡不卡', '我把容器改成了恒定高度',
  'Telegram 那套确实稳', '气泡用的是项目设计 token', '晚上一起复盘下手感', '收到',
  '滚轮惯性还得再调调', '这消息列表能扛几万条了', '你看右边「已挂载节点」', '切数据量它不会涨',
];
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/** mulberry32：seeded PRNG，同 seed 同序列 → generate(count) 数据确定性。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function pad2(n: number): string { return String(n).padStart(2, '0'); }

function formatTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatDateSeparator(d: Date, now: Date): string {
  const dayMs = 86_400_000;
  const diff = Math.floor(midnight(now) / dayMs) - Math.floor(midnight(d) / dayMs);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff >= 2 && diff <= 6) return `周${WEEK[d.getDay()]}`;
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

function midnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 假数据占位图：基于 seed 生成渐变 SVG（dataURL），离线稳定、不依赖图床。 */
function placeholderImage(seed: number): string {
  const h1 = (seed * 53) % 360;
  const h2 = (h1 + 80) % 360;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='300'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='hsl(${h1},65%,58%)'/><stop offset='1' stop-color='hsl(${h2},55%,40%)'/>` +
    `</linearGradient></defs>` +
    `<rect width='400' height='300' fill='url(#g)'/>` +
    `<text x='200' y='172' font-size='36' fill='rgba(255,255,255,0.85)' text-anchor='middle' font-family='sans-serif'>${(seed % 99) + 1}</text>` +
    `</svg>`;
  // data:image/svg+xml,（标准形式，encodeURIComponent 百分号编码；不带非标的 ;utf8 以保最大兼容）。
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * 生成 count 条聊天记录（确定性 seeded）：跨天插 date 分隔、随机切换发送者、随机相册（连续同发送者 media 合并）。
 * 高度天然随机（文本长短/相册张数不同）——故 playground 无需「高度模式」选项。
 * item.id === data.msgId（seed-N / date-N），保证「跳转到 id」与角标 id 一致、稳定可寻址。
 */
function buildItems(count: number): VsItem<ChatItemData>[] {
  const rand = mulberry32(count * 2654435761); // seed 取 count（Knuth 乘数打散）

  type Raw =
    | { kind: 'msg'; isSelf: boolean; text: string; day: number; minutes: number }
    | { kind: 'media'; isSelf: boolean; day: number; minutes: number }
    | { kind: 'date'; day: number };
  const raw: Raw[] = [];
  let lastSelf: boolean | null = null;
  let minutes = 9 * 60;
  let day = 0;
  let mediaBatch = 0;

  const startMs = new Date(2025, 0, 1).getTime();
  const now = new Date();
  const targetDays = Math.max(1, Math.round((now.getTime() - startMs) / 86_400_000));
  const step = Math.max(1, Math.round(count / targetDays));

  for (let i = 0; i < count; i++) {
    if (i > 0 && i % step === 0) {
      day++;
      raw.push({ kind: 'date', day });
      lastSelf = null;
      mediaBatch = 0;
    }
    let isSelf: boolean;
    if (lastSelf === null) isSelf = rand() < 0.5;
    else if (rand() < 0.35) isSelf = !lastSelf;
    else isSelf = lastSelf;
    lastSelf = isSelf;

    minutes += 1 + Math.floor(rand() * 4);
    if (minutes >= 24 * 60) minutes -= 24 * 60;

    if (mediaBatch > 0) {
      raw.push({ kind: 'media', isSelf, day, minutes });
      mediaBatch--;
      continue;
    }
    if (rand() < 0.12) {
      mediaBatch = 1 + Math.floor(rand() * 5);
      raw.push({ kind: 'media', isSelf, day, minutes });
      continue;
    }

    let text = PHRASES[(i * 7) % PHRASES.length];
    if (rand() < 0.3) {
      text = `${PHRASES[(i * 7) % PHRASES.length]}，${PHRASES[(i * 7 + 3) % PHRASES.length]}`;
    }
    raw.push({ kind: 'msg', isSelf, text, day, minutes });
  }

  // 第二遍：连续同发送者 media 聚合为一个相册；msg → ChatMsgData。分组不预烤（渲染时算）。
  const items: VsItem<ChatItemData>[] = [];
  let imgSeed = 0;
  let r = 0;
  while (r < raw.length) {
    const it = raw[r];
    if (it.kind === 'date') {
      const d = new Date(startMs + it.day * 86_400_000);
      items.push({
        id: `date-${items.length}`,
        data: { type: 'date', label: formatDateSeparator(d, now), dayKey: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` },
      });
      r++;
      continue;
    }
    if (it.kind === 'media') {
      const isSelf = it.isSelf;
      const imgs: AlbumImage[] = [];
      while (r < raw.length) {
        const cur = raw[r];
        if (cur.kind !== 'media' || cur.isSelf !== isSelf) break;
        imgs.push({ src: placeholderImage(imgSeed++), w: 400, h: 300 });
        r++;
      }
      const date = new Date(startMs + it.day * 86_400_000 + it.minutes * 60_000);
      items.push({ id: `seed-${items.length}`, data: makeSeedMsg(isSelf, '', 'IMAGE', imgs, date, `seed-${items.length}`) });
      continue;
    }
    const date = new Date(startMs + it.day * 86_400_000 + it.minutes * 60_000);
    const id = `seed-${items.length}`;
    items.push({ id, data: makeSeedMsg(it.isSelf, it.text, 'PURE_TEXT', null, date, id) });
    r++;
  }
  return items;
}

function makeSeedMsg(isSelf: boolean, text: string, contentType: ChatMsgData['contentType'], images: AlbumImage[] | null, date: Date, id: string): ChatMsgData {
  return {
    type: 'msg',
    msgId: id,
    creator: isSelf ? 1 : 2,
    isSelf,
    name: isSelf ? '我' : '阿黄',
    text,
    time: formatTime(date),
    contentType,
    images,
    createdAtMs: date.getTime(),
  };
}
