import { UserAvatarType } from './model';

/** Rendered presentation only. No profile coordinates or authorization evidence. */
export interface AvatarView {
  name: string;
  imageUrl: string | null;
  type: UserAvatarType;
  colorKey?: string;
  federatedDomain?: string | null;
  loading?: boolean;
}

const PALETTE = [
  '#E53935',
  '#D81B60',
  '#8E24AA',
  '#5E35B1',
  '#3949AB',
  '#1E88E5',
  '#039BE5',
  '#00ACC1',
  '#00897B',
  '#43A043',
  '#6D4C41',
  '#546E7A',
];
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function avatarInitial(name: string): string {
  const words = name.trim().split(/\s+/u);
  const graphemes = (word: string, count: number) =>
    Array.from(segmenter.segment(word), ({ segment }) => segment)
      .slice(0, count)
      .join('');
  if (!name.trim()) return '?';
  return (
    words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => graphemes(word, 1))
          .join('')
      : graphemes(words[0], 2)
  ).toLocaleUpperCase();
}

function colorHash(key = ''): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++)
    hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
  return hash >>> 0;
}

export function avatarBackground(view: AvatarView): string {
  return view.type === UserAvatarType.SELF
    ? 'var(--app-avatar-self-bg)'
    : PALETTE[colorHash(view.colorKey) % PALETTE.length];
}

export function avatarGroupFill(view: AvatarView) {
  if (!view.colorKey)
    return {
      id: 'grp-draft',
      from: 'var(--app-action-primary)',
      to: 'var(--app-action-primary)',
    };
  const hash = colorHash(view.colorKey);
  return {
    id: `grp-${hash}`,
    from: PALETTE[hash % PALETTE.length],
    to: PALETTE[(hash + 5) % PALETTE.length],
  };
}
