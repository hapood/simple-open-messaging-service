# Server gaps and new-message arrival

This document records the window behavior for server gaps and new arrivals.
Ordinary `loadOlder` of history that is already covered locally stays.

## 1. Two different holes

A hole in messages that are already stored locally is normal older paging.
`loadOlder` fills it. That path does not create a gap row.

A server gap is a publisher interval the local database has not covered. It is
a display row, not a stable window item. Stable items are mounted messages that
may anchor scrolling. A gap subscribes while it is mounted and unsubscribes
when it leaves, the same way an image display item subscribes.

## 2. First open

The first open has no gap row. Until the first local page exists, the window
is a spinner. After that page is committed, mount its messages. An older
uncovered interval, if one remains, is a subscribed row above those messages.
It is not a gap standing in for the whole thread.

New arrivals follow the bottom only when the added height is at most 70% of
the viewport (`shouldFollowArrival`).

## 3. Filling a server gap

Mounting the gap row subscribes to its thread and interval. The backend then
runs one query for that interval immediately and continues the pull toward
older sequences. A newer tail whose upper edge changed discards an in-flight
page that no longer matches, as in the message-pull design.

The notification carries the thread and the interval. It does not carry the
message page. The gap row then reads one local page, 50 messages by default,
from what is already committed, writes that page into the window cache, and
tells the kernel.

The kernel rereads only that interval. It anchors to the current viewport,
replaces the gap row with the returned messages and any smaller gaps inside
the interval, and trims the window around the viewport. Rows outside the
interval stay mounted.

## 4. Arrival

A newly arrived message triggers a newer load only when the thread's current
latest message is already mounted. If that tail row is not mounted, the
arrival does not load.

After a load that does run, follow the bottom only when the added height is at
most 70% of the viewport.
