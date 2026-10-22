export type OfferPurpose = 'initial' | 'video' | 'restart';
export interface LocalOffer {
  id: string;
  video: boolean;
  restart: boolean;
  sendVideo: boolean;
  receiveVideo: boolean;
}

/** One caller-owned JSEP lane per PC. Intents arriving during async offer creation or
 * while awaiting an answer are coalesced, never used to replace an outstanding offer. */
export class WebCallNegotiation {
  active?: LocalOffer;
  private busy = false;
  private alive = true;
  private initial = false;
  private video = false;
  private restart = false;
  private readonly completed = new Set<string>();

  constructor(
    private readonly produce: (intent: {
      video: boolean;
      restart: boolean;
    }) => Promise<void>,
    private readonly fail: (error: unknown) => void,
  ) {}

  request(purpose: OfferPurpose): void {
    if (!this.alive) return;
    if (purpose === 'initial') this.initial = true;
    if (purpose === 'video') this.video = true;
    if (purpose === 'restart') this.restart = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (
      !this.alive ||
      this.busy ||
      this.active ||
      !(this.initial || this.video || this.restart)
    )
      return;
    this.busy = true;
    const intent = { video: this.video, restart: this.restart };
    this.initial = this.video = this.restart = false;
    try {
      await this.produce(intent);
    } catch (error) {
      if (this.alive) this.fail(error);
    } finally {
      this.busy = false;
      if (this.alive) void this.drain();
    }
  }

  isCompleted(id: string): boolean {
    return this.completed.has(id);
  }
  complete(id: string): void {
    if (!this.alive || this.active?.id !== id) return;
    this.completed.add(id);
    this.active = undefined;
    void this.drain();
  }
  dispose(): void {
    this.alive = false;
    this.active = undefined;
    this.initial = this.video = this.restart = false;
    this.completed.clear();
  }
}

interface IceSection {
  mid?: string;
  ufrag?: string;
}
/** SDP is sent unchanged. This view is used only to route endpoint ICE to media credentials. */
export class RemoteIceGenerations {
  private sections: IceSection[] = [];
  private readonly obsolete = new Set<string>();
  private readonly buffered: RTCIceCandidateInit[] = [];
  private readonly seen = new Set<string>();

  setDescription(sdp: string): void {
    const sections: IceSection[] = [];
    let sessionUfrag: string | undefined;
    let current: IceSection | undefined;
    let bundle: string[] = [];
    for (const line of sdp.split(/\r?\n/)) {
      if (line.startsWith('m=')) {
        current = { ufrag: sessionUfrag };
        sections.push(current);
      } else if (line.startsWith('a=group:BUNDLE ') && !current)
        bundle = line.slice(15).trim().split(/\s+/);
      else if (line.startsWith('a=mid:') && current)
        current.mid = line.slice(6);
      else if (line.startsWith('a=ice-ufrag:')) {
        if (current) current.ufrag = line.slice(12);
        else sessionUfrag = line.slice(12);
      }
    }
    const transportUfrag = sections.find((s) => s.mid === bundle[0])?.ufrag;
    for (const section of sections)
      if (!section.ufrag && section.mid && bundle.includes(section.mid))
        section.ufrag = transportUfrag;
    const next = new Set(sections.map((s) => s.ufrag).filter(Boolean));
    for (const old of this.sections) {
      if (old.ufrag && !next.has(old.ufrag)) this.obsolete.add(old.ufrag);
    }
    for (const ufrag of next) if (ufrag) this.obsolete.delete(ufrag);
    this.sections = sections;
  }

  take(candidate: RTCIceCandidateInit): RTCIceCandidateInit | undefined {
    const ufrag = candidate.usernameFragment;
    if (
      !ufrag ||
      !/^[A-Za-z0-9+/]{4,256}$/.test(ufrag) ||
      this.obsolete.has(ufrag)
    )
      return;
    const embedded = candidate.candidate?.match(/(?:^|\s)ufrag\s+(\S+)/)?.[1];
    if (embedded && embedded !== ufrag) return;
    const section =
      candidate.sdpMid != null
        ? this.sections.find((s) => s.mid === candidate.sdpMid)
        : candidate.sdpMLineIndex != null
          ? this.sections[candidate.sdpMLineIndex]
          : undefined;
    if (section?.ufrag === ufrag) {
      if (
        candidate.sdpMLineIndex != null &&
        this.sections[candidate.sdpMLineIndex] !== section
      )
        return;
      const key = JSON.stringify(candidate);
      if (this.seen.has(key)) return;
      this.seen.add(key);
      if (this.seen.size > 512)
        this.seen.delete(this.seen.values().next().value!);
      return candidate;
    }
    // Unknown credentials may belong to the next restart whose SDP has not arrived.
    if (
      !this.sections.some((s) => s.ufrag === ufrag) &&
      this.buffered.length < 128
    )
      this.buffered.push(candidate);
    return;
  }

  flush(): RTCIceCandidateInit[] {
    const candidates = this.buffered.splice(0);
    return candidates.flatMap((c) => {
      const ready = this.take(c);
      return ready ? [ready] : [];
    });
  }
}

export function negotiatedVideo(
  local: string,
  remote: string,
  send: boolean,
  receive: boolean,
): boolean {
  const direction = (s: string) =>
    s.match(/^a=(sendrecv|sendonly|recvonly|inactive)\r?$/m)?.[1];
  const video = (sdp: string) => {
    const parts = sdp.split(/(?=^m=)/m);
    const sessionDirection =
      direction(parts[0]?.startsWith('m=') ? '' : (parts[0] ?? '')) ??
      'sendrecv';
    return parts
      .filter((s) => /^m=video\s+(?!0(?:\s|$))/.test(s))
      .map((s) => ({
        mid: s.match(/^a=mid:(.+)\r?$/m)?.[1].trim(),
        direction: direction(s) ?? sessionDirection,
      }));
  };
  const localSections = video(local);
  const remoteSections = video(remote);
  return localSections.some((l) =>
    remoteSections.some((r) => {
      if (l.mid !== r.mid) return false;
      const ld = l.direction,
        rd = r.direction;
      if (ld === 'inactive' || rd === 'inactive') return false;
      return (
        (!send ||
          ((ld === 'sendrecv' || ld === 'sendonly') &&
            (rd === 'sendrecv' || rd === 'recvonly'))) &&
        (!receive ||
          ((ld === 'sendrecv' || ld === 'recvonly') &&
            (rd === 'sendrecv' || rd === 'sendonly')))
      );
    }),
  );
}
