import {
  avatarBlobDataUrl,
  decodeProfileAvatar,
} from '../app/services/profile-avatar-bytes';

/** The shared crop editor submits PNG; emulate the server's WebP normalization locally. */
export async function playgroundAvatarUpload(base64: string): Promise<string> {
  const decoded = await decodeProfileAvatar(base64);
  if (!decoded) throw new Error('invalid avatar');
  const bytes = new Uint8Array(await decoded.blob.arrayBuffer());
  const signature = (start: number, end: number) =>
    String.fromCharCode(...bytes.slice(start, end));
  if (signature(0, 4) === 'RIFF' && signature(8, 12) === 'WEBP')
    return avatarBlobDataUrl(decoded.blob);
  if (signature(1, 4) !== 'PNG') throw new Error('invalid avatar');
  const bitmap = await createImageBitmap(
    new Blob([bytes], { type: 'image/png' }),
  );
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('avatar canvas unavailable');
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp'),
    );
    if (!blob || blob.type !== 'image/webp')
      throw new Error('avatar encoding failed');
    return avatarBlobDataUrl(blob);
  } finally {
    bitmap.close();
  }
}
