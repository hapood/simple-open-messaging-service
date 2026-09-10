/** Operator attribution must not change the relationship's directional identity. */
export function relationshipTaskAuthorUserId(task: {
  actorUserId: number | null;
  payload: Record<string, unknown>;
}): number {
  const author = task.payload.intentAuthorUserId ?? task.actorUserId;
  if (
    typeof author !== 'number' ||
    !Number.isSafeInteger(author) ||
    author <= 0
  )
    throw new Error('Relationship task has no valid intent author');
  return author;
}
