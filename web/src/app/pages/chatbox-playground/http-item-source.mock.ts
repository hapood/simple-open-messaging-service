/**
 * Playground mock data layer: MockItemSource (implements CbSource<ChatItemData>) + the deterministic buildItems generator.
 *
 * **Mirrors production**: MockItemSource yields RAW messages (no album merging, no display ids assigned), using the msgId
 *  as the cursor (getOlder/getNewer) — isomorphic to HttpItemSource. Album merging is done by the kernel's mergeItems hook.
 *  buildItems also mirrors production semantics: an album = several consecutive single-image IMAGE messages (same creator),
 *  not "one message with many images".
 *
 * Date separators are NOT produced by the data layer (derived by the front-end createItem).
 */
import { of, firstValueFrom, Observable, type Subscriber } from 'rxjs';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type {
  CbDemand,
  CbDemandResult,
  CbSource,
  CbSourceWindowRequest,
} from '../../lib/chat-box/cb-source';
import type {
  AlbumMedia,
  ChatItemData,
  ChatMsgData,
} from '../../components/message-cards/chat-item';
import {
  parseUserIdentityKey,
  type StandardResponse,
  type User,
} from '../../services/model';
import { messageAuthorAvatarProfile } from '../../services/avatar-profile-ref';

const mockCreatorKey = (id: number): string =>
  JSON.stringify([0, `user-${id}`]);
const mockCreatorId = (key: string): number => {
  const account = parseUserIdentityKey(key)?.account;
  const match = account ? /^user-(\d+)$/.exec(account) : null;
  return match ? Number(match[1]) : Number.NaN;
};

function mockUser(id: number, account: string): readonly [number, User] {
  return [
    id,
    {
      id,
      account,
      name: account[0].toUpperCase() + account.slice(1),
      avatar: '',
      bio: '',
      isGroup: false,
      namespaceId: 0,
      profileRev: 1,
      isDeleted: false,
    },
  ];
}

/**
 * Mirrors production HttpItemSource: a revision-backed sender carries a demand profile ref so the
 * shared presentation pipeline resolves name/avatar; pre-revision senders fall back to a name-only
 * snapshot. Accepts any identity carrying the profile coordinates (mock users and roster members),
 * so live pushes authored under real playground accounts resolve like production rows.
 */
export function mockSender(
  user: Pick<User, 'account' | 'namespaceId' | 'profileRev'> | undefined,
  fallbackName: string,
): ChatMsgData['sender'] {
  const profile = user
    ? messageAuthorAvatarProfile({
        publisherNamespaceId: 0,
        profileNamespaceId: user.namespaceId,
        profileRev: user.profileRev,
        creator: { account: user.account },
      })
    : undefined;
  const domainSource = {
    type: 'profile-namespace' as const,
    publisherNamespaceId: 0,
    profileNamespaceId: user?.namespaceId ?? 0,
  };
  return profile
    ? {
        kind: 'demand',
        profile,
        fallbackName,
        account: user?.account ?? '',
        domainSource,
      }
    : {
        kind: 'snapshot',
        name: fallbackName,
        imageUrl: null,
        account: user?.account ?? '',
        domainSource,
      };
}

/** Mock user table (id → User). Mirrors the production backend user table; MockItemSource.ensureProfiles looks up by creator here. */
const MOCK_USERS: ReadonlyMap<number, User> = new Map([
  mockUser(1, 'me'),
  mockUser(2, 'alice'),
  mockUser(3, 'maya'),
  mockUser(4, 'noah'),
  mockUser(5, 'olivia'),
]);

/**
 * Playground-only profile fixtures keyed by message sender.
 * The mock is in-memory (synchronous `of`); production is HTTP; identical signatures → MockItemSource.ensureProfiles is
 * isomorphic to the production HttpItemSource.
 */
export class MockUserService {
  /** Returns User[] for the given userIds (`of` synchronous, simulating HTTP). */
  queryUserInfo(params: {
    userIds: number[];
  }): Observable<StandardResponse<User[]>> {
    const data = params.userIds
      .map((id) => MOCK_USERS.get(id))
      .filter((u): u is User => !!u);
    return of({ code: 0, message: 'ok', data });
  }
}

/**
 * Per-request page ceiling — mirrors production `HttpItemSource.MAX_PAGE` (the backend `QueryMessagesDto` enforces
 * `@Max(50)`). The mock MUST honor the same cap so the playground reproduces production's pagination behavior: when the
 * kernel asks for more than MAX_PAGE (e.g. initBatch=100), the mock returns one page (50) and the kernel's normal
 * top-up (the init fill loop / balance getOlder) fetches the rest on demand. Without this cap the mock returned the
 * full olderCount in init, whose larger first batch usually cleared the 6000px threshold in one shot → the multi-batch
 * init fill never ran in the playground, masking init-fill bugs production hits (e.g. the stuck mid-list spinner).
 */
const MAX_PAGE = 50;

/**
 * Playground mock data source: implements {@link CbSource}<{@link ChatItemData}>, backed by the deterministic buildItems generator.
 *
 * [Logical sequence] `sequence() = [...full, ...live]` ascending (oldest → newest): full = buildItems history,
 *  live = WS new messages from appendLive. cursorId (msgId) is located via findIndex in this sequence.
 *  - `full[k].id = k + 1` (a positive message seq; stable and addressable).
 *  - A live item's id = the caller-supplied msgId (playground allocateMsgId() autoincrement).
 *
 * [Cursors] getOlder(cursorId, count) takes `count` items BEFORE the cursor (older); getNewer takes AFTER (newer).
 *  Reaching the sequence start (oldest) → out[0] is tagged 'oldest'; reaching the end (newest) → out[last] 'newest'.
 *  Returned ascending.
 *
 * @param total generator seed (deterministic data volume == full.length; buildItems produces exactly `total` items).
 * @param latency simulated IO latency (ms); tests pass 0 so init/getOlder/getNewer resolve in the same frame.
 */
export class MockItemSource implements CbSource<ChatItemData> {
  private readonly full: CbItem<ChatItemData>[];
  private readonly live: CbItem<ChatItemData>[] = [];
  /** Next server-assigned msgId (autoincrement, mirroring production `Message.seq`). Seeded to `total + 1` so the first
   *  send continues past buildItems history (`1..total`) without collision.
   *  {@link allocateMsgId} is the mock "server write" that mints the real seq for a confirmed optimistic send. */
  private nextMsgId: number;
  /** Simulated IO latency (ms); the playground adjusts it live (0/200/1s/5s) to test slow-loading behavior. */
  latency: number;
  /** Mock user-query service (mirrors production UserService); ensureProfiles looks up creators on it to fill `profiles`. */
  private readonly userService: MockUserService;
  /** Current user id (isSelf is decided as creator === userId). */
  private readonly userId: number;
  private readonly isGroupConversation: boolean;
  /** User-info cache (creator → name/isSelf), filled by ensureProfiles looking up creators on userService — mirrors HttpItemSource.profiles. */
  private readonly profiles = new Map<
    string,
    { name: string; isSelf: boolean }
  >();
  private readonly newerWaiters = new Set<{
    cursorId: number;
    count: number;
    subscriber: Subscriber<CbDemandResult<ChatItemData>>;
  }>();
  private readonly pumpingWaiters = new WeakSet<object>();
  private liveRevision = 0;

  constructor(
    total: number,
    private readonly entryReadSeq: number,
    latency: number,
    userService: MockUserService,
    userId: number,
    isGroupConversation = false,
    groupSenderCount = 1,
  ) {
    this.full = buildItems(
      total,
      isGroupConversation ? Math.max(1, Math.min(4, groupSenderCount)) : 1,
    );
    this.latency = latency;
    this.userService = userService;
    this.userId = userId;
    this.isGroupConversation = isGroupConversation;
    this.nextMsgId = total + 1;
  }

  /** Search the same in-memory history rendered by the production thread shell. */
  search(keyword: string, take: number): { seq: number; createdAt: number }[] {
    const query = keyword.trim().toLocaleLowerCase();
    if (!query) return [];
    return this.sequence()
      .filter(
        (item) =>
          item.data.type === 'msg' &&
          `${item.data.text} ${item.data.file?.name ?? ''}`
            .toLocaleLowerCase()
            .includes(query),
      )
      .slice()
      .sort((a, b) => b.id - a.id)
      .slice(0, take)
      .map((item) => ({ seq: item.id, createdAt: item.data.createdAtMs }));
  }

  /** Keep a withdrawn mock message absent from later pagination or search requests. */
  withdraw(seq: number): void {
    const fullIndex = this.full.findIndex((item) => item.id === seq);
    if (fullIndex >= 0) this.full.splice(fullIndex, 1);
    const liveIndex = this.live.findIndex((item) => item.id === seq);
    if (liveIndex >= 0) this.live.splice(liveIndex, 1);
  }

  async prepareEntry() {
    return {
      lastReadSeq: this.entryReadSeq,
      hasCachedMessages: this.sequence().length > 0,
      hasCachedHead: this.sequence().length > 0,
    };
  }

  async loadWindow(
    request: CbSourceWindowRequest,
  ): Promise<CbItem<ChatItemData>[]> {
    await this.wait();
    const seq = this.sequence();
    switch (request.kind) {
      case 'cached':
      case 'latest':
        return this.shapeWindow(
          seq,
          Math.max(0, seq.length - Math.min(request.count, MAX_PAGE)),
          seq.length,
        );
      case 'start':
        return this.shapeWindow(
          seq,
          0,
          Math.min(seq.length, request.count, MAX_PAGE),
        );
      case 'around': {
        // The cursor is a coordinate, not a requirement for an extant row.
        const firstNewer = seq.findIndex((item) => item.id > request.messageId);
        const split = firstNewer < 0 ? seq.length : firstNewer;
        return this.shapeWindow(
          seq,
          Math.max(0, split - Math.min(request.olderCount, MAX_PAGE)),
          Math.min(seq.length, split + Math.min(request.newerCount, MAX_PAGE)),
        );
      }
    }
  }

  private async shapeWindow(
    sequence: CbItem<ChatItemData>[],
    start: number,
    end: number,
  ): Promise<CbItem<ChatItemData>[]> {
    const raw = sequence.slice(start, end);
    if (raw.length === 0) return [];
    await this.ensureProfiles(raw);
    const items = raw.map((item) => this.shape(item));
    const atOldest = start === 0;
    const atNewest = end === sequence.length;
    if (atOldest && atNewest && items.length === 1) {
      items[0] = { ...items[0], boundary: 'both' };
    } else {
      if (atOldest) items[0] = { ...items[0], boundary: 'oldest' };
      if (atNewest)
        items[items.length - 1] = {
          ...items[items.length - 1],
          boundary: 'newest',
        };
    }
    return items;
  }

  /** Fetch `count` items older than cursorId (ascending; excludes the cursor). Reaching the sequence start → out[0] tagged 'oldest'. */
  async getOlder(
    cursorId: number,
    count: number,
  ): Promise<CbItem<ChatItemData>[]> {
    await this.wait();
    const seq = this.sequence();
    const idx = seq.findIndex((it) => it.id === cursorId);
    if (idx < 0) return [];
    const take = Math.min(count, MAX_PAGE);
    const start = Math.max(0, idx - take);
    const raw = seq.slice(start, idx);
    if (raw.length === 0) return [];
    await this.ensureProfiles(raw);
    const items = raw.map((it) => this.shape(it));
    if (start === 0) items[0] = { ...items[0], boundary: 'oldest' };
    return items;
  }

  /**
   * Fetch `count` items newer than cursorId (ascending; excludes cursor). Returns reals only — in-flight
   * optimistic sends are mounted separately by the kernel at the newest edge via {@link getPending}. As a side
   * effect, reconciles pending: any pending entry whose clientMessageId matches a returned real is dropped (the
   * confirm arrived). Tags the last returned item 'newest' when the real batch reached the sequence end.
   */
  async getNewer(
    cursorId: number,
    count: number,
  ): Promise<CbItem<ChatItemData>[]> {
    await this.wait();
    const seq = this.sequence();
    const start = seq.findIndex((item) => item.id > cursorId);
    if (start < 0) return [];
    const take = Math.min(count, MAX_PAGE);
    const end = Math.min(seq.length, start + take);
    const rawReal = seq.slice(start, end);
    const reachedEnd = end === seq.length;


    const items: CbItem<ChatItemData>[] = [];
    if (rawReal.length > 0) {
      await this.ensureProfiles(rawReal);
      for (const it of rawReal) items.push(this.shape(it));
    }
    if (items.length === 0) return [];

    // Tag the last item 'newest' when the real batch reached the sequence end.
    if (reachedEnd) {
      items[items.length - 1] = {
        ...items[items.length - 1],
        boundary: 'newest',
      };
    }
    return items;
  }

  requestOlder(cursorId: number, count: number): CbDemand<ChatItemData> {
    return mockDemand(async () => {
      const items = await this.getOlder(cursorId, count);
      return items.length > 0 ? { kind: 'items', items } : { kind: 'boundary' };
    });
  }

  requestMessagesForEmptyWindow(count: number): CbDemand<ChatItemData> {
    return this.requestNewer(this.entryReadSeq, count);
  }

  requestNewer(cursorId: number, count: number): CbDemand<ChatItemData> {
    return new Observable((subscriber) => {
      const waiter = { cursorId, count, subscriber };
      this.newerWaiters.add(waiter);
      void this.pumpNewerWaiter(waiter);
      return () => {
        this.newerWaiters.delete(waiter);
      };
    });
  }

  private async pumpNewerWaiter(waiter: {
    cursorId: number;
    count: number;
    subscriber: Subscriber<CbDemandResult<ChatItemData>>;
  }): Promise<void> {
    if (this.pumpingWaiters.has(waiter)) return;
    this.pumpingWaiters.add(waiter);
    const revision = this.liveRevision;
    try {
      const items = await this.getNewer(waiter.cursorId, waiter.count);
      if (!this.newerWaiters.has(waiter) || items.length === 0) return;
      this.newerWaiters.delete(waiter);
      waiter.subscriber.next({ kind: 'items', items });
      waiter.subscriber.complete();
    } catch (error) {
      if (!this.newerWaiters.delete(waiter)) return;
      waiter.subscriber.next({ kind: 'error', error });
      waiter.subscriber.complete();
    } finally {
      this.pumpingWaiters.delete(waiter);
      if (this.newerWaiters.has(waiter) && this.liveRevision !== revision)
        void this.pumpNewerWaiter(waiter);
    }
  }

  /** Cache a live (WS-pushed) real message into `live`. Cache-only — no merge, no shape, no return; the kernel
   *  pulls it back via getNewer on the next signal (where pending reconcile + shape happen). id = the caller-given
   *  msgId (playground makeMockItem / the confirmed optimistic id). */
  pushLive(rawItems: CbItem<ChatItemData>[]): void {
    for (const raw of rawItems) this.live.push(raw);
    this.liveRevision++;
    for (const waiter of this.newerWaiters) void this.pumpNewerWaiter(waiter);
  }

  /** Allocate the next server msgId for a confirmed optimistic send (mock autoincrement, mirroring production
   *  `Message.seq`). The playground's confirmPending calls this to mint the real seq that replaces the optimistic's
   *  synthetic negative placeholder id. */
  allocateMsgId(): number {
    return this.nextMsgId++;
  }

  destroy(): void {
    for (const waiter of this.newerWaiters) waiter.subscriber.complete();
    this.newerWaiters.clear();
  }

  // ---------- Logical sequence ----------

  /** full (history) + live (WS) concatenated, ascending (oldest → newest). */
  private sequence(): CbItem<ChatItemData>[] {
    return [...this.full, ...this.live];
  }

  /** Collect missing creators → look them up on userService to fill `profiles` (mirrors HttpItemSource.ensureProfiles). */
  private async ensureProfiles(items: CbItem<ChatItemData>[]): Promise<void> {
    const missing = new Set<number>();
    for (const it of items) {
      if (it.data.type !== 'msg') continue;
      const creator = it.data.creator;
      if (it.data.sender || this.profiles.has(creator)) continue;
      const creatorId = mockCreatorId(creator);
      // Live pushes can arrive under real-account identity keys (not the
      // synthetic `user-N` scheme); they carry their own sender and need no
      // fixture lookup, so only resolvable ids reach the query.
      if (Number.isFinite(creatorId)) missing.add(creatorId);
    }
    if (missing.size === 0) return;
    const res = await firstValueFrom(
      this.userService.queryUserInfo({ userIds: [...missing] }),
    );
    if (res.code === 0 && res.data) {
      for (const u of res.data)
        this.profiles.set(mockCreatorKey(u.id), {
          name: u.name || u.account,
          isSelf: u.id === this.userId,
        });
    }
  }

  /** Shape: clone the item, drop boundary, and fill name/isSelf from `profiles` by creator (mirrors production toMsgData;
   *  fallback 'Unknown' / creator===userId). Preserves clientMessageId (the optimistic↔real reconcile key) so a confirmed
   *  real returned by getNewer still carries it — shape must not strip the correlation key the kernel pairs on. */
  private shape(it: CbItem<ChatItemData>): CbItem<ChatItemData> {
    if (it.data.type !== 'msg') return it;
    const creator = it.data.creator;
    const creatorId = mockCreatorId(creator);
    const p = this.profiles.get(creator);
    const data: ChatMsgData = {
      ...it.data,
      name: it.data.sender ? it.data.name : (p?.name ?? 'Unknown'),
      isSelf: it.data.sender
        ? it.data.isSelf
        : (p?.isSelf ?? creatorId === this.userId),
      avatarIdentityId: creator,
      // Authored echoes retain the revision/snapshot selected when sending.
      sender:
        it.data.sender ??
        mockSender(MOCK_USERS.get(creatorId), p?.name ?? 'Unknown'),
      senderDisplayContext: this.isGroupConversation ? 'group' : 'direct',
      isGroupConversation: this.isGroupConversation,
    };
    return it.clientMessageId !== undefined
      ? { id: it.id, data, clientMessageId: it.clientMessageId }
      : { id: it.id, data };
  }

  private wait(): Promise<void> {
    return new Promise((r) => setTimeout(r, this.latency));
  }
}

function mockDemand<T>(work: () => Promise<CbDemandResult<T>>): CbDemand<T> {
  return new Observable((subscriber) => {
    void work()
      .catch((error): CbDemandResult<T> => ({ kind: 'error', error }))
      .then((result) => {
        if (subscriber.closed) return;
        subscriber.next(result);
        subscriber.complete();
      });
  });
}

// ---------- Data generation (deterministic) ----------

const PHRASES = [
  'You there?',
  'The virtual scroll kernel is running',
  'Is the list smooth on your side?',
  'I switched the container to a fixed height',
  "Telegram's approach is rock solid",
  'Bubbles use the project design tokens',
  "Let's review the feel tonight",
  'Got it',
  'Wheel inertia still needs tuning',
  'This list holds tens of thousands now',
  'Check the "mounted nodes" on the right',
  'Switch the data volume, it stays flat',
];

/** mulberry32: a seeded PRNG — the same seed yields the same sequence, so generate(count) is deterministic. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Fake placeholder image: a seed-based gradient SVG (dataURL) generated at the real aspect ratio rw×rh — offline-stable, no image host needed. */
function placeholderImage(seed: number, rw: number, rh: number): string {
  const h1 = (seed * 53) % 360;
  const h2 = (h1 + 80) % 360;
  // SVG sized to the real aspect ratio (long edge = 400), so the placeholder's own ratio matches the data w/h → justified row-layout verification stays realistic.
  const W = rw >= rh ? 400 : Math.round((400 * rw) / rh);
  const H = rh >= rw ? 400 : Math.round((400 * rh) / rw);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='hsl(${h1},65%,58%)'/><stop offset='1' stop-color='hsl(${h2},55%,40%)'/>` +
    `</linearGradient></defs>` +
    `<rect width='${W}' height='${H}' fill='url(#g)'/>` +
    `<text x='${W / 2}' y='${H / 2 + 12}' font-size='36' fill='rgba(255,255,255,0.85)' text-anchor='middle' font-family='sans-serif'>${(seed % 99) + 1}</text>` +
    `</svg>`;
  // data:image/svg+xml, (standard form, percent-encoded by encodeURIComponent; no non-standard ;utf8 suffix → maximum compatibility).
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Album aspect-ratio pool (landscape / square / portrait, close to real phone-camera ratios); seeded random pick → drives layoutAlbum justified-row verification. */
const RATIOS: ReadonlyArray<[number, number]> = [
  [16, 9],
  [4, 3],
  [1, 1],
  [3, 4],
  [9, 16],
];

/**
 * Generate EXACTLY `count` chat records (deterministic, seeded): each round yields 1 msg (text or single-image IMAGE),
 * until `count` is reached.
 * **Mirrors production**: an album = several consecutive single-image IMAGE messages (same creator, adjacent in time),
 *  merged by the kernel's mergeItems into one album item (isomorphic to production's "rawToItems yields one IMAGE per msg"
 *  + mergeItems merge; no longer "one msg with many images").
 * Cross-day: a new day every `step` msgs (only the createdAtMs is spread across days; the date separator is derived by
 *  the front-end createItem, not produced here).
 * Random sender switching; naturally random heights (text length / album size differ). item.id === data.msgId (the
 *  generation index, a numeric seq), stable and addressable — mirrors production Message.seq (a number autoincrement).
 */
function buildItems(
  count: number,
  otherSenderCount = 1,
): CbItem<ChatItemData>[] {
  const rand = mulberry32(count * 2654435761); // seed = count (scrambled by the Knuth multiplier)
  const items: CbItem<ChatItemData>[] = [];
  let lastCreator: number | null = null;
  let minutes = 9 * 60;
  let day = 0;
  let imgSeed = 0;
  let msgSinceDay = 0; // msgs produced so far today; at `step` a new day begins (spreads createdAtMs across days → the front-end cross-day check has something to do)

  const startMs = new Date(2025, 0, 1).getTime();
  const targetDays = Math.max(
    1,
    Math.round((Date.now() - startMs) / 86_400_000),
  );
  const step = Math.max(1, Math.round(count / targetDays));

  while (items.length < count) {
    // A new day every `step` msgs: the date separator is no longer produced by the source — here we only spread the
    // msgs' createdAtMs across days; the front-end createItem factory renders the date pill from the cross-day check
    // (see message-cards/date-format.ts).
    if (items.length > 0 && msgSinceDay >= step) {
      day++;
      msgSinceDay = 0;
      lastCreator = null;
    }
    let creator: number;
    const maxCreator = 1 + Math.max(1, Math.min(4, otherSenderCount));
    if (lastCreator === null)
      creator = rand() < 0.5 ? 1 : 2 + Math.floor(rand() * (maxCreator - 1));
    else if (rand() < 0.35) {
      do {
        creator = 1 + Math.floor(rand() * maxCreator);
      } while (creator === lastCreator);
    } else creator = lastCreator;
    lastCreator = creator;

    if (rand() < 0.12) {
      // Album: n consecutive single-image IMAGE messages (same creator); the kernel's mergeItems merges them into one album item.
      const n = 1 + Math.floor(rand() * 6);
      for (let k = 0; k < n && items.length < count; k++) {
        minutes += 1 + Math.floor(rand() * 4);
        if (minutes >= 24 * 60) minutes -= 24 * 60;
        msgSinceDay++;
        const date = new Date(startMs + day * 86_400_000 + minutes * 60_000);
        const [rw, rh] = RATIOS[Math.floor(rand() * RATIOS.length)];
        const id = items.length + 1;
        const imgs: AlbumMedia[] = [
          {
            kind: 'image',
            src: placeholderImage(imgSeed++, rw, rh),
            w: rw * 100,
            h: rh * 100,
            size: 200_000 + Math.floor(rand() * 2_800_000),
            name: `photo-${id}.svg`, mimeType: 'image/svg+xml', senderName: null, sentAt: date.getTime(),
            msgId: id,
          },
        ];
        items.push({
          id,
          data: makeSeedMsg(creator, '', 'IMAGE', imgs, date, id),
        });
      }
    } else {
      minutes += 1 + Math.floor(rand() * 4);
      if (minutes >= 24 * 60) minutes -= 24 * 60;
      msgSinceDay++;
      const date = new Date(startMs + day * 86_400_000 + minutes * 60_000);
      let text = PHRASES[(items.length * 7) % PHRASES.length];
      if (rand() < 0.3)
        text = `${PHRASES[(items.length * 7) % PHRASES.length]}. ${PHRASES[(items.length * 7 + 3) % PHRASES.length]}`;
      const id = items.length + 1;
      items.push({
        id,
        data: makeSeedMsg(creator, text, 'PURE_TEXT', null, date, id),
      });
    }
  }
  return items;
}

function makeSeedMsg(
  creator: number,
  text: string,
  ...[contentType, images, date, id]:
    | ['IMAGE', AlbumMedia[], Date, number]
    | ['PURE_TEXT', null, Date, number]
): ChatMsgData {
  // Raw msg: carries no name/isSelf (placeholder); MockItemSource.shape fills them from `profiles` by creator — mirrors production toMsgData.
  return {
    type: 'msg',
    msgId: id,
    creator: mockCreatorKey(creator),
    isSelf: false,
    name: '',
    text,
    time: formatTime(date),
    ...(contentType === 'IMAGE'
      ? { contentType, images, file: null }
      : { contentType, images: null, file: null }),
    createdAtMs: date.getTime(),
  };
}
