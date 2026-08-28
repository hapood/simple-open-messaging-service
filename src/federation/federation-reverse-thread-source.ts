export type FederationReverseThreadSource =
  | {
      kind: 'GROUP';
      threadId: number;
      peerDomain: string;
      selector: { account: string };
    }
  | {
      kind: 'P2P';
      threadId: number;
      peerDomain: string;
      selector: { account: string; peerAccount: string };
    };
