export const federationNodes = Object.freeze({
  alpha: {
    edge: 'http://localhost:3101/',
    admin: 'http://localhost:3101/admin/',
    domain: 'alpha.test',
  },
  bravo: {
    edge: 'http://localhost:3102/',
    admin: 'http://localhost:3102/admin/',
    domain: 'bravo.test',
  },
  charlie: {
    edge: 'http://localhost:3103/',
    admin: 'http://localhost:3103/admin/',
    domain: 'charlie.test',
  },
});
export const playgroundOrigin = 'http://127.0.0.1:4301';

export function assertTarget(target) {
  if (target !== 'playground' && target !== 'federation')
    throw new Error(
      'Select target playground or federation when opening a profile.',
    );
  return target;
}

export function navigationUrl(target, node, rawUrl, nodes = federationNodes) {
  assertTarget(target);
  if (target === 'playground' && node !== undefined)
    throw new Error('Playground has no federation node.');
  if (
    target === 'federation' &&
    node !== undefined &&
    !Object.hasOwn(nodes, node)
  )
    throw new Error('Unknown federation node.');
  const url = new URL(
    rawUrl ??
      (target === 'playground'
        ? `${playgroundOrigin}/`
        : nodes[node ?? 'alpha'].edge),
  );
  const allowed =
    target === 'playground'
      ? [playgroundOrigin]
      : Object.values(nodes).flatMap((entry) => [
          new URL(entry.edge).origin,
          new URL(entry.admin).origin,
        ]);
  if (url.username || url.password || !allowed.includes(url.origin))
    throw new Error(`Navigation is outside the ${target} approved origins.`);
  if (
    node &&
    ![nodes[node].edge, nodes[node].admin].some(
      (base) => url.origin === new URL(base).origin,
    )
  )
    throw new Error('URL does not match the selected federation node.');
  return url.href;
}

/** A profile name refers to one target for the lifetime of its on-disk data. */
export function assertProfileTarget(existing, requested) {
  assertTarget(requested);
  if (existing && existing !== requested)
    throw new Error(
      `Profile belongs to ${existing}, not ${requested}; use a different profile name.`,
    );
  return requested;
}
