import type { ProfileRequest } from '../../../../shared/profile-demand';
import { tauriInvoke } from './runtime';
import type {
  ProfileWatchEngine,
  ProfileWatchSink,
  NamespaceWatchSink,
  ResolvedProfile,
} from './profile-watch.service';
import type {
  ProfileNamespaceBinding,
  ProfileNamespacePairKey,
  WebdbService,
} from './webdb.service';
/** Push states from `native_watch_profile`. Mirrors the Rust
 *  `ProfileWatchEvent` wire shape. */
type ProfileWatchIpcEvent =
  | { state: 'empty' }
  | {
      state: 'ready';
      profile: {
        publisherNamespaceId: number;
        profileNamespaceId: number;
        account: string;
        profileRev: number;
        name: string;
        bio: string;
        avatarDigest: string | null;
      };
    }
  | { state: 'failed'; reason: string };

/** Push states from `native_watch_namespace`. Mirrors the Rust
 *  `NamespaceWatch` wire shape. */
type NamespaceWatchIpcEvent =
  | { state: 'empty' }
  | { state: 'ready'; binding: ProfileNamespaceBinding }
  | { state: 'unrecoverable' }
  | { state: 'failed'; reason: string };

/** One native watch registration: the invoke resolves with the watch id after
 *  the forwarder is registered; cancellation may be requested before that, so
 *  the id is captured and the cancel is sent as soon as it is known. */
interface NativeWatchRegistration {
  cancel(): void;
}

/** Native engine: the whole watch machinery (LRU, dedup, request rounds,
 *  wakes) lives in Rust behind `native_watch_profile` / `native_watch_namespace`
 *  push channels. The web-side engine is a thin transport: subscribe, forward
 *  states, cancel. Dropping the channel (page reload) releases the Rust watch
 *  including its in-flight HTTP request. Structurally implements
 *  `ProfileWatchEngine` (no runtime base-class link, keeping the module graph
 *  acyclic). */
export class NativeProfileWatchEngine {
  constructor(private readonly webdb: WebdbService) {}

  private userId(): number {
    const userId = this.webdb.numericUserId;
    if (userId === null) throw new Error('account cache lifetime expired');
    return userId;
  }

  private register<Event>(
    command: 'native_watch_profile' | 'native_watch_namespace',
    args: Record<string, unknown>,
    onEvent: (event: Event) => void,
  ): NativeWatchRegistration {
    const Channel = window.__TAURI__?.core?.Channel;
    if (!Channel) throw new Error('native IPC channel unavailable');
    const channel = new Channel<Event>(onEvent);
    let watchId: string | null = null;
    let cancelled = false;
    void tauriInvoke<string>(command, { ...args, events: channel }).then(
      (id) => {
        watchId = id;
        if (cancelled) this.cancelWatch(id);
      },
      (error) => {
        if (!cancelled)
          onEvent({
            state: 'failed',
            reason: String(error),
          } as unknown as Event);
      },
    );
    return {
      cancel: () => {
        cancelled = true;
        if (watchId !== null) this.cancelWatch(watchId);
      },
    };
  }

  private cancelWatch(watchId: string): void {
    void tauriInvoke('native_watch_cancel', { watchId }).catch((error) =>
      console.warn('[profile-watch] native cancellation failed', error),
    );
  }

  subscribeProfile(
    request: ProfileRequest,
    sink: ProfileWatchSink,
  ): () => void {
    let registration: NativeWatchRegistration;
    try {
      registration = this.register<ProfileWatchIpcEvent>(
        'native_watch_profile',
        { userId: this.userId(), request },
        (event) => this.onProfileEvent(event, sink),
      );
    } catch (error) {
      sink.error(error);
      return () => undefined;
    }
    return () => registration.cancel();
  }

  subscribeNamespace(
    pair: ProfileNamespacePairKey,
    sink: NamespaceWatchSink,
  ): () => void {
    let registration: NativeWatchRegistration;
    try {
      registration = this.register<NamespaceWatchIpcEvent>(
        'native_watch_namespace',
        { userId: this.userId(), pair },
        (event) => {
          if (event.state === 'empty') {
            sink.next(null);
          } else if (event.state === 'ready') {
            sink.next(event.binding);
          } else if (event.state === 'unrecoverable') {
            sink.error(new Error('namespace binding unrecoverable'));
          } else {
            sink.error(new Error(event.reason));
          }
        },
      );
    } catch (error) {
      sink.error(error);
      return () => undefined;
    }
    return () => registration.cancel();
  }

  private onProfileEvent(
    event: ProfileWatchIpcEvent,
    sink: ProfileWatchSink,
  ): void {
    if (event.state === 'empty') {
      sink.next(null);
      return;
    }
    if (event.state === 'failed') {
      sink.error(new Error(event.reason));
      return;
    }
    const snapshot = event.profile;
    void this.materializeProfile(snapshot).then(
      (profile) => {
        sink.next(profile);
        sink.complete();
      },
      (error) => sink.error(error),
    );
  }

  /** Attach the digest-addressed avatar bytes to a pushed snapshot, mirroring
   *  the browser engine's post-commit read. */
  private async materializeProfile(snapshot: {
    publisherNamespaceId: number;
    profileNamespaceId: number;
    account: string;
    profileRev: number;
    name: string;
    bio: string;
    avatarDigest: string | null;
  }): Promise<ResolvedProfile> {
    const avatarBlob = snapshot.avatarDigest
      ? await this.webdb.getProfileAvatarBlob(snapshot.avatarDigest)
      : null;
    if (snapshot.avatarDigest && !avatarBlob)
      throw new Error('resolved profile avatar bytes are missing');
    return {
      publisherNamespaceId: snapshot.publisherNamespaceId,
      namespaceId: snapshot.profileNamespaceId,
      account: snapshot.account,
      rev: snapshot.profileRev,
      name: snapshot.name,
      bio: snapshot.bio,
      avatarDigest: snapshot.avatarDigest,
      avatarBlob: avatarBlob ?? null,
    };
  }
}
