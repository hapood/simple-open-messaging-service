import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readdir, type FileHandle } from 'node:fs/promises';
import { sql, type SQL } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { dataDirectory } from '../common/data-directory.js';
import { UploadService } from '../upload/upload.service.js';
import { ResumableUploadService } from '../upload/resumable-upload.service.js';
import { FederationDownloadScheduler } from '../federation/federation-download-scheduler.js';
import {
  garbageDigest,
  garbageFingerprint,
  garbageGroup,
  hasUnsupportedNode,
  inspectGarbageNode,
  inspectGarbageTree,
  openGarbageRoot,
  removeGarbageNode,
  type GarbageNode,
  type GarbageRoot,
} from './temporary-garbage-files.js';

interface Candidate {
  root: GarbageRoot;
  kind: 'upload' | 'download' | 'unknown' | 'directory';
  key: string;
  nodes: GarbageNode[];
}
interface Ticket extends Candidate {
  fingerprint: string;
  expires: number;
}
interface Ownership {
  eligible: boolean;
  tasks: { id: string; status: string }[];
}
type Executor = {
  execute: (query: SQL) => Promise<{ rows: Record<string, unknown>[] }>;
};

/** Explicit temporary cleanup. Task-owned uploads are deleted through their cancellation lifecycle. */
@Injectable()
export class TemporaryGarbageService {
  private readonly tickets = new Map<string, Ticket>();
  constructor(
    private readonly database: DatabaseService,
    private readonly upload: UploadService,
    private readonly resumable: ResumableUploadService,
    private readonly scheduler: FederationDownloadScheduler,
  ) {}

  private rootPath(root: GarbageRoot) {
    return root === 'resumable'
      ? dataDirectory('resumable')
      : this.upload.casTmpDir;
  }

  private async candidates(root: GarbageRoot, handle: FileHandle) {
    const groups = new Map<string, Candidate>();
    for (const name of (await readdir(`/proc/self/fd/${handle.fd}`)).sort()) {
      const node = await inspectGarbageNode(handle, name);
      if (!node) continue;
      const group = garbageGroup(root, node);
      const id = `${group.kind}:${group.key}`;
      const candidate = groups.get(id) ?? { root, ...group, nodes: [] };
      candidate.nodes.push(node);
      groups.set(id, candidate);
    }
    return [...groups.values()];
  }

  private digest(candidate: Candidate) {
    return candidate.root === 'cas'
      ? candidate.kind === 'download'
        ? candidate.key
        : garbageDigest(candidate.key)
      : null;
  }

  private async ownership(
    candidate: Candidate,
    db: Executor,
  ): Promise<Ownership> {
    const digest = this.digest(candidate);
    const result =
      candidate.kind === 'upload'
        ? await db.execute(sql`
          SELECT id::text AS id, status::text AS status FROM "UploadSession"
          WHERE "tmpKey" = ${candidate.key}::uuid`)
        : digest
          ? await db.execute(sql`
            SELECT id::text AS id, status::text AS status FROM "UploadSession" WHERE digest = ${digest}
            UNION ALL
            SELECT f."batchId"::text AS id, f.status::text AS status
            FROM "FileSyncProgress" f WHERE f.digest = ${digest}`)
          : { rows: [] };
    const tasks = result.rows.map((row) => ({
      id: String(row.id),
      status: String(row.status),
    }));
    return {
      eligible:
        tasks.every(
          (row) =>
            row.status === 'FAILED' ||
            (candidate.kind === 'upload' && row.status === 'PENDING'),
        ) && !(digest && this.scheduler.hasDigest(digest)),
      tasks,
    };
  }

  async scan() {
    // Tokens are short lived and process-local; requests can never supply a filesystem path.
    for (const [id, ticket] of this.tickets)
      if (ticket.expires < Date.now()) this.tickets.delete(id);
    const candidates: Candidate[] = [];
    for (const root of ['resumable', 'cas'] as const) {
      const handle = await openGarbageRoot(this.rootPath(root));
      if (!handle) continue;
      try {
        candidates.push(...(await this.candidates(root, handle)));
      } finally {
        await handle.close();
      }
    }
    candidates.sort(
      (a, b) =>
        this.modified(a) - this.modified(b) ||
        `${a.root}:${a.key}`.localeCompare(`${b.root}:${b.key}`),
    );
    const list = [];
    let eligibleCount = 0;
    for (const candidate of candidates) {
      const ownership = await this.ownership(candidate, this.database.db);
      if (!ownership.eligible) continue;
      eligibleCount++;
      if (list.length >= 20) continue;
      const supported = !candidate.nodes.some(hasUnsupportedNode);
      const token = randomUUID();
      if (this.tickets.size >= 2000)
        this.tickets.delete(this.tickets.keys().next().value!);
      this.tickets.set(token, {
        ...candidate,
        fingerprint: garbageFingerprint(candidate.nodes),
        expires: Date.now() + 15 * 60_000,
      });
      list.push({
        token,
        root: candidate.root,
        kind: candidate.kind,
        name: candidate.key,
        files: candidate.nodes.map((node) => node.name),
        bytes:
          candidate.kind === 'directory'
            ? null
            : String(
                candidate.nodes.reduce((sum, node) => sum + node.bytes, 0),
              ),
        modifiedAt: new Date(this.modified(candidate)).toISOString(),
        tasks: ownership.tasks,
        canDelete: supported,
        blockedReason: supported ? null : 'unsupported-entry',
      });
    }
    return { list, total: eligibleCount, limit: 20 };
  }

  private modified(candidate: Candidate) {
    return Math.max(...candidate.nodes.map((node) => node.modified));
  }

  async clean(token: string, confirmDirectory = false) {
    const ticket = this.tickets.get(token);
    if (!ticket || ticket.expires < Date.now())
      throw new ConflictException('scan expired; scan again');
    if (ticket.kind === 'directory' && !confirmDirectory)
      throw new ConflictException(
        'explicit recursive directory confirmation required',
      );
    if (ticket.nodes.some(hasUnsupportedNode))
      throw new ConflictException('unsupported temporary entry');
    if (
      ticket.kind === 'upload' &&
      (await this.resumable.cancelTemporaryUpload(ticket.key))
    ) {
      // Cancellation owns draining and deletion. Never perform a second unlink here:
      // an explicit retry may create fresh staging after the command has settled.
      this.tickets.delete(token);
      return { cleaned: true };
    }
    const operation = async () =>
      this.database.db.transaction(async (tx) => {
        // Protect absent-row admission as well as retries across API instances. Acquire only after
        // local IO queues, in the same upload-before-progress order as media maintenance. No task
        // record is modified; write exclusion lasts only for this explicitly requested group.
        await tx.execute(
          sql`LOCK TABLE "UploadSession", "FileSyncProgress", "PendingMedia" IN SHARE ROW EXCLUSIVE MODE`,
        );
        const ownership = await this.ownership(ticket, tx);
        if (
          !ownership.eligible ||
          (ticket.kind === 'upload' && ownership.tasks.length > 0)
        )
          throw new ConflictException(
            'temporary files have an active or completed owner; scan again',
          );
        const handle = await openGarbageRoot(this.rootPath(ticket.root));
        if (!handle)
          throw new ConflictException(
            'temporary entry disappeared; scan again',
          );
        try {
          const candidate = (await this.candidates(ticket.root, handle)).find(
            (item) => item.kind === ticket.kind && item.key === ticket.key,
          );
          if (
            !candidate ||
            garbageFingerprint(candidate.nodes) !== ticket.fingerprint
          )
            throw new ConflictException('temporary entry changed; scan again');
          // Listing is shallow. Inspect a directory only after explicit deletion
          // confirmation, rejecting unsupported descendants before removing anything.
          const nodes: GarbageNode[] = [];
          for (const node of candidate.nodes) {
            const inspected =
              node.kind === 'directory'
                ? await inspectGarbageTree(handle, node.name)
                : node;
            if (!inspected || inspected.identity !== node.identity)
              throw new ConflictException(
                'temporary entry changed; scan again',
              );
            if (hasUnsupportedNode(inspected))
              throw new ConflictException('unsupported temporary entry');
            nodes.push(inspected);
          }
          for (const node of nodes) await removeGarbageNode(handle, node);
          this.tickets.delete(token);
          return { cleaned: true };
        } finally {
          await handle.close();
        }
      });
    const digest = this.digest(ticket);
    return digest
      ? this.upload.withCasDigestLock(digest, operation)
      : operation();
  }
}
