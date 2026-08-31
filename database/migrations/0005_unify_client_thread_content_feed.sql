-- Clean cut: thread content now lives exclusively in ClientStateFeed.
DROP TABLE "ClientMessageTombstoneFeed";
DROP TABLE "ClientMessageFeed";
DROP TABLE "ClientMessageFeedTarget";
