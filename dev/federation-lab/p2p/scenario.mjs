import { federationLabNodes } from '../topology.mjs';

export function pairKey(left, right) {
  if (left === right) throw new Error('a P2P pair requires two users');
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

export function buildUserPlan(prefix, usersPerNode, random) {
  return Array.from({ length: usersPerNode }, (_, index) =>
    federationLabNodes.map((node) => {
      const ordinal = String(index + 1).padStart(3, '0');
      const account = `${prefix}-${node.name[0]}-${ordinal}`;
      const richProfile = random?.chance(50) ?? false;
      return {
        nodeName: node.name,
        domain: node.domain,
        account,
        name: `${node.name} ${ordinal}`,
        bio: richProfile ? `Initial federation profile ${account}` : '',
        avatar: richProfile,
        address: `${account}@${node.domain}`,
      };
    }),
  ).flat();
}

export function buildGroupCreationPlan(prefix, users, groupsPerNode, random) {
  return federationLabNodes.flatMap((node) => {
    const localUsers = users.filter(({ nodeName }) => node.name === nodeName);
    if (localUsers.length === 0)
      throw new Error(`cannot create groups on ${node.name} without users`);
    return Array.from({ length: groupsPerNode }, (_, index) => {
      const ordinal = String(index + 1).padStart(3, '0');
      const richProfile = random.chance(50);
      return {
        nodeName: node.name,
        owner: localUsers[random.integer(localUsers.length)].address,
        name: `${prefix}-${node.name}-group-${ordinal}`,
        description: richProfile
          ? `Initial federation group ${node.name} ${ordinal}`
          : '',
        avatar: richProfile,
      };
    });
  });
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

  chance(numerator, denominator = 100) {
    if (
      !Number.isSafeInteger(numerator) ||
      !Number.isSafeInteger(denominator) ||
      numerator < 0 ||
      denominator <= 0 ||
      numerator > denominator
    )
      throw new Error('invalid random probability');
    return this.integer(denominator) < numerator;
  }

  pick(values) {
    if (values.length === 0) throw new Error('cannot pick from an empty list');
    return values[this.integer(values.length)];
  }
}
