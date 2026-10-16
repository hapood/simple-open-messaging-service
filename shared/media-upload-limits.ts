/** Message attachments must be strictly smaller than one GiB, regardless of media family. */
export const MAX_MEDIA_FILE_BYTES = 1024 * 1024 * 1024 - 1;

/** Per-request transfer bound, independent of the complete attachment size. */
export const MEDIA_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
