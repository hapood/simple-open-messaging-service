# Chat media thumbnail presentation plan

Implementation plan for [Chat media thumbnail presentation](./chat-media-thumbnail-presentation.md).
The design states the target. This plan lists the work required to reach it.

## 1. Thumbnail cell

- Finish `AlbumMediaCellComponent` as the only painter of one image or video thumbnail.
- Subscribe to digest progress while mounted, and cancel only that subscription on unmount.
- Paint the shared circular progress over the kind icon while progress is unfinished, including zero and not-yet-started progress.
- Paint the thumbnail after the terminal completed progress state.
- Paint the failure placeholder when the thumbnail request fails. Do not hide the image.
- Support the album size and the smaller file-group slot size without a second state machine.

## 2. Album rows

- Render each album image and video as a nested cell.
- Remove thumbnail URL calculation, availability observation, and progress painting from the album row.
- Keep album membership changes on the kernel height path. Thumbnail state changes must not request a layout transaction.

## 3. File-group card and panel

- Render at most six slots from the message projection. More than six files uses five resource slots plus the count affordance.
- Share the fixed-size download mask and circular progress for every file kind,
  including audio and generic files. Only images and videos request thumbnails.
- Apply the same per-resource presentation to the opened immersive viewer,
  without the six-slot limit. Remove the mask on readiness; retain nonvisual kind
  icons and expose audio playback without a separate audio download state machine.
- Delete the frontend and backend request that fetches six file records for card painting.
- Delete the aggregate file-group progress calculation and the card's direct thumbnail URL path.
- Delete the gallery thumbnail error handler that only hides the image.

## 4. Server-download speed and transfer boundaries

- Share per-resource server-download progress between outer placeholders and the
  detail panel. Do not aggregate file-group progress or speed.
- Outer album cells and file-group card slots show circular progress without speed.
- The detail panel shows server-download speed below the spinner on the large
  file-kind placeholder; image detail placeholders follow the same rule.
- Keep generic-file progress separate from thumbnail readiness: files without a
  thumbnail retain their kind icon while observing their server download.
- Compute `bytesPerSecond` in the server download execution and include it in
  per-digest progress SSE. Frontends format it without independent sampling.
- Never derive this speed from client-side original-file or thumbnail downloads.
- Native server-to-client download progress belongs in the download manager. Web
  downloads are browser-owned. Remove client-download progress from these
  server-download placeholders rather than displaying both in the same location.
- Reserve integer-pixel space for detail speed labels and test that outer slots
  never render speed.

## 5. Unified immersive viewer

- Route single files, images, videos, audio and file groups into the same viewer.
- Remove `FileDetailViewerComponent`, its templates/styles and `FileDetailService`;
  migrate thread and forward-detail callers and deletion-driven dismissal.
- Show a large centered kind icon for generic files, without View original.
- Reserve View original for images. Keep original preview loading separate from
  server-download presentation and from the common save action.
- Render current-resource metadata: filename, size, format/type, optional sender
  and sent time; image dimensions; video dimensions/duration; audio duration.
- Carry available message-owned metadata through resource projections. Do not
  populate metadata with a separate file-list query.
- Reuse one original-file Download action and the shared native download manager;
  let the browser own Web saves. Remove viewer-local client-download progress
  panels and their obsolete calculations/styles.
- Verify all file kinds, missing metadata, long filenames, navigation past six
  resources, server progress/speed, and deletion while the viewer is open.

## 6. Rust thumbnail cache

- Keep the existing per-digest cache read and single in-flight server request.
- Persist a thumbnail download failure by digest.
- A later request for a failed digest returns that stored failure and does not contact the server again.
- Dropping one subscriber must not abort the request while another subscriber remains.

## 6. Verification

- Cell unmount cancels its progress subscription without affecting another cell observing the same digest.
- Completed progress replaces the placeholder with the thumbnail.
- A failed thumbnail remains failed across remount.
- A file-group card does not request a separate six-file list or compute aggregate progress.
- Album thumbnail updates do not change the kernel height model.
