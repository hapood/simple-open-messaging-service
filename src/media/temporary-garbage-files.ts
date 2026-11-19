import { ConflictException } from '@nestjs/common';
import { constants } from 'node:fs';
import {
  open,
  type FileHandle,
  lstat,
  readdir,
  unlink,
  rmdir,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export type GarbageRoot = 'resumable' | 'cas';
export interface GarbageNode {
  name: string;
  kind: 'file' | 'directory' | 'unsupported';
  bytes: number;
  modified: number;
  identity: string;
  children?: GarbageNode[];
}

/** Pin every directory component without following links. Descriptor-relative traversal keeps
 * rename/symlink replacement from redirecting cleanup outside the configured trees. Fail closed
 * on hosts without Linux descriptor paths rather than falling back to path-based recursion. */
export async function openGarbageRoot(
  path: string,
): Promise<FileHandle | null> {
  if (process.platform !== 'linux')
    throw new ConflictException(
      'safe temporary cleanup requires Linux descriptor paths',
    );
  let handle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const component of resolve(path).split('/').filter(Boolean)) {
      const next = await open(
        descriptorPath(handle, component),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ConflictException(
      'temporary directory is not a safe physical directory',
    );
  }
}

function descriptorPath(parent: FileHandle, name: string) {
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name))
    throw new ConflictException('invalid temporary entry');
  return `/proc/self/fd/${parent.fd}/${name}`;
}

/** Read only this directory entry; listing never opens or enumerates descendants. */
export async function inspectGarbageNode(
  parent: FileHandle,
  name: string,
): Promise<GarbageNode | null> {
  const path = descriptorPath(parent, name);
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  const kind = info.isFile()
    ? 'file'
    : info.isDirectory()
      ? 'directory'
      : 'unsupported';
  const node: GarbageNode = {
    name,
    kind,
    bytes: kind === 'file' ? info.size : 0,
    modified: info.mtimeMs,
    identity: `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
  };
  return node;
}

/** Build a bounded safety snapshot only after recursive deletion is confirmed. */
export function inspectGarbageTree(
  parent: FileHandle,
  name: string,
): Promise<GarbageNode | null> {
  return inspectTree(parent, name, { remaining: 10_000 }, 0);
}

async function inspectTree(
  parent: FileHandle,
  name: string,
  budget: { remaining: number },
  depth: number,
): Promise<GarbageNode | null> {
  if (--budget.remaining < 0 || depth > 32)
    throw new ConflictException(
      'temporary directory exceeds safe inspection limits',
    );
  const node = await inspectGarbageNode(parent, name);
  if (!node) return null;
  if (node.kind === 'directory') {
    const child = await open(
      descriptorPath(parent, name),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const pinned = await child.stat();
      if (!node.identity.startsWith(`${pinned.dev}:${pinned.ino}:`))
        throw new ConflictException(
          'temporary directory changed during inspection',
        );
      node.children = [];
      for (const entry of (await readdir(`/proc/self/fd/${child.fd}`)).sort()) {
        const item = await inspectTree(child, entry, budget, depth + 1);
        if (item) node.children.push(item);
      }
      node.bytes = node.children.reduce((sum, item) => sum + item.bytes, 0);
      // An unexpected directory is one candidate, ordered by its own mtime.
      // Descendant identities remain part of deletion safety, not list ordering.
    } finally {
      await child.close();
    }
  }
  return node;
}

export function garbageFingerprint(nodes: GarbageNode[]) {
  return createHash('sha256').update(JSON.stringify(nodes)).digest('hex');
}

export function hasUnsupportedNode(node: GarbageNode): boolean {
  return (
    node.kind === 'unsupported' ||
    (node.children?.some(hasUnsupportedNode) ?? false)
  );
}

/** The caller holds domain locks and has revalidated the complete snapshot before any removal.
 * Each descent is pinned and checked again. Links and device/socket entries are never traversed. */
export async function removeGarbageNode(
  parent: FileHandle,
  node: GarbageNode,
): Promise<void> {
  const path = descriptorPath(parent, node.name);
  const current = await inspectGarbageTree(parent, node.name);
  if (!current || garbageFingerprint([current]) !== garbageFingerprint([node]))
    throw new ConflictException('temporary entry changed; scan again');
  if (node.kind === 'unsupported')
    throw new ConflictException('unsupported temporary entry');
  if (node.kind === 'file') {
    await unlink(path);
    return;
  }
  const child = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const pinned = await child.stat();
    if (!node.identity.startsWith(`${pinned.dev}:${pinned.ino}:`))
      throw new ConflictException('temporary directory changed; scan again');
    for (const entry of node.children ?? [])
      await removeGarbageNode(child, entry);
    await rmdir(path);
  } finally {
    await child.close();
  }
}

const uploadPattern =
  /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.(?:part|resume\.json(?:\.tmp)?)$/;
const downloadPattern =
  /^([a-f0-9]{64})\.(?:part|resume\.json(?:\.tmp)?|complete(?:\.tmp)?)$/;
export function garbageGroup(root: GarbageRoot, node: GarbageNode) {
  const match =
    node.kind === 'file'
      ? (root === 'resumable' ? uploadPattern : downloadPattern).exec(node.name)
      : null;
  return match
    ? {
        kind:
          root === 'resumable' ? ('upload' as const) : ('download' as const),
        key: match[1],
      }
    : {
        kind:
          node.kind === 'directory'
            ? ('directory' as const)
            : ('unknown' as const),
        key: node.name,
      };
}

/** Buffer publication leftovers stay separate rows but still participate in digest locking. */
export function garbageDigest(name: string): string | null {
  return /^([a-f0-9]{64})\./.exec(name)?.[1] ?? null;
}
