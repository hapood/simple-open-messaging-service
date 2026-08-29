export type FederationReverseThreadSource =
  | {
      kind: 'GROUP';
      threadId: number;
      peerDomain: string;
      namespaceId: number;
      selector: { account: string };
    }
  | {
      kind: 'P2P';
      threadId: number;
      peerDomain: string;
      namespaceId: number;
      selector: { account: string; peerAccount: string };
    };
