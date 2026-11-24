# Chat media thumbnail presentation

Non-height-changing media observations belong to the mounted message component.
The chat kernel measures and repositions a host only when album membership changes
its height. Thumbnail progress, failure, and completion stay inside the row.

## Component ownership

- A message row subscribes to availability and transfer progress for the resources
  it paints. Unmounting the row cancels only that row's subscriptions.
- Album images and videos are nested cells. Each cell owns one resource identity,
  its thumbnail request, and its progress subscription.
- A file-group card paints at most six slots. Each visible image or video slot is
  the same thumbnail cell at a smaller size. The sixth slot is a count affordance
  when the group contains more than six files; it is not a seventh thumbnail.
- Every file kind, including audio and generic files, uses the same per-resource
  server-download observation and fixed-size masked circular progress presentation.
- Opening any attachment uses the immersive viewer, including single generic files
  and file groups. Every displayed resource queries its own progress. The viewer
  does not inherit the card's six-slot limit.
- Tombstones, message insertion, and album membership changes remain session-level
  work. They are not moved into a thumbnail cell.

## Transfer ownership and speed presentation

Two different transfers must never share this presentation:

- Server-side file download: the application server acquires the original file.
  This is the progress observed by message placeholders and the file-group detail
  panel. It includes server-side image downloads.
- Client-side file download: the client receives bytes from the application
  server. Native clients show this transfer in the download manager; the browser
  owns Web downloads. Its progress and speed must not appear in the message
  placeholder or the file-group detail panel's server-download indicator.

Outer album cells and file-group card slots show the shared circular progress
indicator without download speed. The detail panel shows server-download speed
beneath the spinner on the large file-kind placeholder. Image detail placeholders
follow the same rule: circular progress outside, circular progress plus speed
inside. The visibility difference must not introduce a second progress state
machine or an aggregate file-group speed calculation.

The server download execution computes `bytesPerSecond` and includes it in the
per-digest progress SSE. Clients only format this value; mounts must not create
independent speed samplers. Pending or terminal states have no speed; a running
transfer may report zero when stalled. Speed is per resource, never a group sum.

Speed belongs to the original server-side download, not to the thumbnail derivative
request. The speed label occupies a reserved, integer-pixel area beneath the spinner
inside the large detail placeholder. Outer slots and the viewer's compact navigation
rail hide speed. Updates must not change the chat kernel's height model.

## Completion and progress

Server-side original-file transfer progress exists for every managed file download. A resource
is ready for thumbnail presentation only when its original bytes are stored and its
server thumbnail has been generated. Thumbnail bytes are a separate derivative
request; they are not embedded in the message body.

The presentation states are:

- Transfer not finished: every file kind shows a mask with the shared circular
  progress over its kind icon, including zero and not-yet-started progress. The
  allocated surface size is fixed across all states.
- Transfer finished: remove the mask. Generic files retain their kind icon; audio
  exposes its playback surface. Images and videos use the server thumbnail after
  the derivative request succeeds. Never probe a local video first frame as a
  thumbnail fallback.
- Thumbnail request fails after readiness: show the shared thumbnail-failure
  placeholder. Hiding the image is not the failure presentation.

There is no separate completion query. The progress observation is sufficient:
completion is the terminal progress state, after which the cell requests the
thumbnail URL. Rust downloads one thumbnail per digest and reuses that in-flight
request for every subscriber. Cells still retain independent subscriptions so an
unmounted cell stops observing without cancelling another visible subscriber.

## File groups

A file-group card reads the file count, sizes, and per-file metadata already
present in the message projection. It does not make another file-list request or
compute one aggregate progress value for the card.

All visible slots share the same server-download state machine. Audio and generic
files have no server thumbnail; their slot keeps the file-kind icon after the mask
is removed. Clicking the card opens the full group in the immersive viewer.

## Unified immersive attachment viewer

Single attachments and file groups use one viewer and one download action. Remove
the old generic-file detail dialog, its service and entry-point routing rather
than retaining it as a fallback. Preserve deletion-driven dismissal and access
checks when migrating those entry points, including forwarded attachments.

### Content by kind

- Image: show the server thumbnail when ready; offer View original only for images
  when the original is not already displayed. Original-image loading is distinct
  from saving a file and must not reuse the server-download mask or speed label.
- Video: show the server thumbnail before playback; the player owns playback,
  not thumbnail generation. No image-specific View original action.
- Audio: use the same fixed-size masked download surface while pending, then
  expose playback controls after server readiness. Remove the old audio-specific
  download presentation rather than maintaining two download state machines.
- Generic file: show a larger file-kind icon at the center, even after completion.
  Do not offer View original or attempt an image/video preview.

### Metadata and actions

Keep one metadata area outside the central progress overlay and above the compact
navigation rail. It follows the current resource, not the first item in the group.
Long names wrap within a bounded area; metadata changes must not resize outer chat
cards. Chrome visibility follows the viewer's existing immersive controls.

| Kind | Metadata |
| --- | --- |
| All | Full filename, byte size, format/type; sender and sent time when supplied by the owning message |
| Image | Pixel dimensions |
| Video | Pixel dimensions and duration |
| Audio | Duration |
| Generic file | File extension or MIME type; no fabricated dimensions or duration |

Omit unknown fields instead of inventing values. Message-owned metadata must travel
with each projected resource; do not fetch a second file list to populate the viewer.

Use one Download action for images, videos, audio and generic files. It saves the
original resource using its real filename and MIME type, never the thumbnail.
Enable it only when server readiness and access permit. Native saves enter the
shared download manager; Web saves are handed to the browser. Client transfer
progress and speed are shown by those owners, not in the central server-download
placeholder. Keep server-download retry separate from client-download retry.

## Identity and cache

Progress and cache identity are the content digest. A mounted cell reads the
cached thumbnail first. A miss starts one server request for that digest, and
every concurrent subscriber reuses it. Unsubscribing stops observation only;
it does not cancel a request still observed by another cell.

A failed thumbnail download is stored against the digest. Later mounts show the
failure placeholder and do not request that digest again.

Audio and generic files share server-download observation and mask presentation,
but never enter the thumbnail derivative request/cache state machine.
