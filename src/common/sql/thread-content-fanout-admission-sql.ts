import { sql, type SQL } from 'drizzle-orm';

/** Admits a thread-content fan-out from an owning statement's `system_message`
 * and `seq_alloc` CTEs. A pending task is advanced; a running task is untouched. */
export function threadFanoutAdmissionSql(params: {
  threadId: number;
  /** CTE name prefix; must be unique within the owning statement. */
  prefix: string;
  federation: boolean;
}): SQL {
  const scopeKey = JSON.stringify([
    params.federation ? 'FEDERATION_THREAD_FANOUT' : 'THREAD_FANOUT',
    params.threadId,
  ]);
  const taskType = params.federation
    ? 'FAN_OUT_FEDERATION_THREAD_CONTENT'
    : 'FAN_OUT_THREAD_CONTENT';
  const prefix = sql.raw(params.prefix);
  return sql`
    ${prefix}_merge AS (
      UPDATE "DurableTask" d SET payload = jsonb_build_object(
        'threadId', ${params.threadId}::integer,
        'messageEndSeq', GREATEST((d.payload->>'messageEndSeq')::bigint, (SELECT seq FROM system_message)),
        'tombstoneEndSeq', GREATEST((d.payload->>'tombstoneEndSeq')::bigint,
          (SELECT "tombstoneEndSeq" FROM seq_alloc)))
      WHERE EXISTS (SELECT 1 FROM system_message) AND d.kind = 'PROJECTION'
        AND d."scopeType" = 'THREAD' AND d."scopeKey" = ${scopeKey}
        AND d."taskType" = ${taskType} AND d.status = 'PENDING'
      RETURNING d.id
    ), ${prefix}_insert AS (
      INSERT INTO "DurableTask"
        (kind, "scopeType", "scopeKey", "taskType", payload, "coalescingKey", status)
      SELECT 'PROJECTION'::"DurableTaskKind", 'THREAD'::"DurableTaskScopeType", ${scopeKey},
        ${taskType},
        jsonb_build_object('threadId', ${params.threadId}::integer,
          'messageEndSeq', (SELECT seq FROM system_message),
          'tombstoneEndSeq', (SELECT "tombstoneEndSeq" FROM seq_alloc)),
        ${scopeKey}, 'PENDING'::"DurableTaskStatus"
      WHERE EXISTS (SELECT 1 FROM system_message)
        AND NOT EXISTS (SELECT 1 FROM ${prefix}_merge)
      RETURNING id
    )`;
}
