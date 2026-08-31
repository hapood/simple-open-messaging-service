/** A federation wire address. The account and domain remain separate on the wire. */
export interface S2SAddress {
  account: string;
  domain: string;
}
