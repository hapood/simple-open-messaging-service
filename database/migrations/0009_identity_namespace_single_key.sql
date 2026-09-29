ALTER TABLE "ThreadAudience" DROP CONSTRAINT "ThreadAudience_targetNamespace_fkey";
ALTER TABLE "FederatedPeer" DROP CONSTRAINT "FederatedPeer_activeNamespace_fkey";
ALTER TABLE "PeerStateFeed" DROP CONSTRAINT "PeerStateFeed_namespace_fkey";
ALTER TABLE "PeerStateFeedPullCursor" DROP CONSTRAINT "PeerStateFeedPullCursor_namespace_fkey";
ALTER TABLE "S2SKeyCache" DROP CONSTRAINT "S2SKeyCache_namespace_fkey";

ALTER TABLE "ThreadAudience"
  ADD CONSTRAINT "ThreadAudience_targetNamespace_fkey"
  FOREIGN KEY ("targetNamespaceId") REFERENCES "IdentityNamespace"("id") ON DELETE RESTRICT;
ALTER TABLE "FederatedPeer"
  ADD CONSTRAINT "FederatedPeer_activeNamespace_fkey"
  FOREIGN KEY ("activeNamespaceId") REFERENCES "IdentityNamespace"("id") ON DELETE RESTRICT;
ALTER TABLE "PeerStateFeed"
  ADD CONSTRAINT "PeerStateFeed_namespace_fkey"
  FOREIGN KEY ("namespaceId") REFERENCES "IdentityNamespace"("id") ON DELETE RESTRICT;
ALTER TABLE "PeerStateFeedPullCursor"
  ADD CONSTRAINT "PeerStateFeedPullCursor_namespace_fkey"
  FOREIGN KEY ("namespaceId") REFERENCES "IdentityNamespace"("id") ON DELETE RESTRICT;
ALTER TABLE "S2SKeyCache"
  ADD CONSTRAINT "S2SKeyCache_namespace_fkey"
  FOREIGN KEY ("namespaceId") REFERENCES "IdentityNamespace"("id") ON DELETE RESTRICT;
