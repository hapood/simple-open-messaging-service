export type FederationReverseThreadSource =
  | {
      kind: 'GROUP';
      localGroupAuthority: boolean;
      threadId: number;
      peerDomain: string;
      namespaceId: number;
      demand: { account: string };
    }
  | {
      kind: 'P2P';
      threadId: number;
      peerDomain: string;
      namespaceId: number;
      demand: { account: string; peerAccount: string };
    };
