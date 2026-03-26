import { extname } from 'node:path';

/**
 * Builds a deterministic child journal path for one nested subquery invocation.
 */
export function createSubqueryJournalPath(
  parentJournalPath: string,
  depth: number,
  queryIndex: number,
): string {
  const extension = extname(parentJournalPath);
  const suffix = `.subquery.d${depth}.q${queryIndex}`;

  if (extension.length === 0) {
    return `${parentJournalPath}${suffix}`;
  }

  return `${parentJournalPath.slice(0, -extension.length)}${suffix}${extension}`;
}
