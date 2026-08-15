/**
 * Magic-byte media signature detection for the video/audio upload routes. The backend validates the
 * container FAMILY (is this really a video/audio container, not a forged MIME or a polyglot?) but
 * does NOT probe codecs/duration/dimensions — those are the frontend's job (<video>/<audio>
 * loadedmetadata). This keeps the backend ffmpeg-free.
 *
 * Returns the on-disk extension (trusted — derived from the actual bytes, not the client filename)
 * and the family, so saveCas() can name the shard file and the route can gate on family. `null`
 * means "no recognized container signature" → the route rejects.
 *
 * Accepted limitations (by design):
 *  - The ISO BMFF `ftyp` box is shared by mp4 (video) and m4a (audio); we split on the brand
 *    (M4A/M4B/M4P → audio, everything else → video mp4). .mov uses the qt brand but is served as
 *    .mp4 (video/mp4) — browsers play it identically.
 *  - webm and mkv share the EBML signature and are both accepted as .webm.
 *  - Backend validates the container, not codec validity. A truncated/corrupt file with a valid
 *    header is accepted; the frontend <video>/<audio> degrades gracefully (error event → placeholder).
 */

export type MediaFamily = 'image' | 'video' | 'audio';

export interface DetectedMedia {
  family: MediaFamily;
  ext: string; // trusted on-disk extension (no dot)
}

interface Sig {
  family: MediaFamily;
  ext: string;
  match: (b: Buffer) => boolean;
}

/** ASCII equality at an offset, bounds-checked. */
function eq(b: Buffer, offset: number, ascii: string): boolean {
  return (
    b.length >= offset + ascii.length &&
    b.slice(offset, offset + ascii.length).toString('latin1') === ascii
  );
}

/**
 * Signature table. ORDER MATTERS: audio brands of the shared ftyp/RIFF containers are checked BEFORE
 * the video fallbacks, so m4a (ftyp + M4A brand) and wav (RIFF + WAVE) resolve as audio rather than
 * falling through to the generic video mp4/avi rules.
 */
const SIGS: Sig[] = [
  // Images (centralized here so isImage can delegate; magic bytes for png/jpg/gif/webp).
  {
    family: 'image',
    ext: 'png',
    match: (b) =>
      b.length >= 4 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47,
  },
  {
    family: 'image',
    ext: 'jpg',
    match: (b) =>
      b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    family: 'image',
    ext: 'gif',
    match: (b) => b.length >= 4 && b.slice(0, 4).toString('latin1') === 'GIF8',
  },
  {
    family: 'image',
    ext: 'webp',
    match: (b) => b.length >= 12 && eq(b, 0, 'RIFF') && eq(b, 8, 'WEBP'),
  },

  // Audio — checked before video so the shared containers (ftyp/RIFF) resolve to audio for audio brands.
  {
    family: 'audio',
    ext: 'mp3',
    match: (b) =>
      b.length >= 3 &&
      (eq(b, 0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)),
  },
  { family: 'audio', ext: 'ogg', match: (b) => eq(b, 0, 'OggS') }, // ogg / opus-in-ogg
  { family: 'audio', ext: 'flac', match: (b) => eq(b, 0, 'fLaC') },
  {
    family: 'audio',
    ext: 'wav',
    match: (b) => eq(b, 0, 'RIFF') && eq(b, 8, 'WAVE'),
  },
  {
    family: 'audio',
    ext: 'm4a',
    match: (b) =>
      b.length >= 12 &&
      eq(b, 4, 'ftyp') &&
      ['M4A ', 'M4B ', 'M4P '].includes(b.slice(8, 12).toString('latin1')),
  },

  // Video.
  {
    family: 'video',
    ext: 'webm',
    match: (b) =>
      b.length >= 4 &&
      b[0] === 0x1a &&
      b[1] === 0x45 &&
      b[2] === 0xdf &&
      b[3] === 0xa3,
  }, // EBML (webm/mkv)
  { family: 'video', ext: 'flv', match: (b) => eq(b, 0, 'FLV') },
  {
    family: 'video',
    ext: 'avi',
    match: (b) => eq(b, 0, 'RIFF') && eq(b, 8, 'AVI '),
  },
  { family: 'video', ext: 'mp4', match: (b) => eq(b, 4, 'ftyp') }, // ISO BMFF; audio brands caught above
];

/**
 * Detect a media container family + trusted extension from the leading bytes. Returns null when no
 * known signature matches. Used by the upload routes to gate video/audio and to derive the on-disk
 * extension (the client filename is NOT trusted for the extension).
 */
export function detectMedia(buf: Buffer): DetectedMedia | null {
  if (!buf || buf.length < 4) return null;
  for (const sig of SIGS) {
    if (sig.match(buf)) return { family: sig.family, ext: sig.ext };
  }
  return null;
}
