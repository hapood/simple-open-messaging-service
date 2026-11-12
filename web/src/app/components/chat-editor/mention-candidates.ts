/** Allocate a five-row local-search page before querying ordinary members.
 * The built-in audience row participates in the same substring search and
 * consumes one slot only when the viewer may use it and its label matches.
 */
export function mentionSearchPlan(
  query: string,
  allLabel: string,
  canMentionAll: boolean,
): { includeAll: boolean; memberLimit: number } {
  const includeAll =
    canMentionAll &&
    allLabel.toLowerCase().includes(query.trim().toLowerCase());
  return { includeAll, memberLimit: includeAll ? 4 : 5 };
}
