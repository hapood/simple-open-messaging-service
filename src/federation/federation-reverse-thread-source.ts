export type FederationReverseThreadSource =
  | {
      kind: 'GROUP';
      localGroupAuthority: boolean;
      threadId: number;
      namespaceId: number;
      demand: { account: string };
    }
  | {
      kind: 'P2P';
      threadId: number;
      namespaceId: number;
      demand: { account: string; peerAccount: string };
    };
