import { federationLabNodes } from '../topology.mjs';

export function pairKey(left, right) {
  if (left === right) throw new Error('a P2P pair requires two users');
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

export function buildUserPlan(prefix, usersPerNode) {
  return Array.from({ length: usersPerNode }, (_, index) =>
    federationLabNodes.map((node) => {
      const ordinal = String(index + 1).padStart(3, '0');
      const account = `${prefix}-${node.name[0]}-${ordinal}`;
      return {
        nodeName: node.name,
        domain: node.domain,
        account,
        name: `${node.name} ${ordinal}`,
        address: `${account}@${node.domain}`,
      };
    }),
  ).flat();
}

export class SeededRandom {
  constructor(seed) {
    this.state = seed >>> 0;
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  next() {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }

  integer(maxExclusive) {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0)
      throw new Error('random integer bound must be a positive safe integer');
    return Math.floor(this.next() * maxExclusive);
  }

  boolean() {
    return this.integer(2) === 0;
  }
}
