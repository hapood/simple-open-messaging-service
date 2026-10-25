import {
  catchError,
  defer,
  forkJoin,
  from,
  map,
  Observable,
  of,
  switchMap,
  take,
} from 'rxjs';
import { ALL_MENTION_ID } from '../../lib/message-entity';
import { avatarProfileDemand } from '../../services/avatar-profile-ref';
import { avatarBlobDataUrl } from '../../services/profile-avatar-bytes';
import type { ProfileRepository } from '../../services/profile-store.service';
import type { ChatMember } from '../chat-editor/chat-editor.component';

type NativeMentionCandidate = {
  id: string;
  label: string;
} & (
  | { kind: 'all'; avatar: { kind: 'builtin'; icon: 'everyone' } }
  | {
      kind: 'user';
      avatar: {
        kind: 'user';
        url?: string;
        fallbackText: string;
        colorSeed: string;
      };
    }
);

/** The platform renderer accepts image bytes, not Angular demand components. */
export function nativeMentionPresentation(
  members: readonly ChatMember[],
  profiles: Pick<ProfileRepository, 'resolve'>,
): Observable<NativeMentionCandidate[]> {
  if (members.length === 0) return of([]);
  return forkJoin(
    members.map((member): Observable<NativeMentionCandidate> => {
      if (member.id === ALL_MENTION_ID)
        return of({
          id: member.id,
          label: member.label,
          kind: 'all',
          avatar: { kind: 'builtin', icon: 'everyone' },
        });
      const demand = avatarProfileDemand(member.profile);
      const avatar: Observable<string | undefined> = demand
        ? defer(() => profiles.resolve(demand)).pipe(
            take(1),
            switchMap((profile) =>
              profile.avatarBlob
                ? from(avatarBlobDataUrl(profile.avatarBlob))
                : of(undefined),
            ),
            catchError(() => of(undefined)),
          )
        : of(undefined);
      return avatar.pipe(
        map((url) => ({
          id: member.id,
          label: member.label,
          kind: 'user',
          avatar: {
            kind: 'user',
            url,
            fallbackText: avatarFallbackText(member.label),
            colorSeed: member.id,
          },
        })),
      );
    }),
  );
}

function avatarFallbackText(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1)
    return `${Array.from(words[0])[0] ?? ''}${Array.from(words[1])[0] ?? ''}`.toLocaleUpperCase();
  return (Array.from(words[0] ?? '')[0] ?? '?').toLocaleUpperCase();
}
