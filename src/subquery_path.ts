/**
 * Journal-path helpers for naming nested subquery logs deterministically.
 *
 * @module
 *
 * @example
 * ```ts
 * import { createSubqueryJournalPath } from './subquery_path.ts';
 * ```
 */
import { extnameFilePath } from './platform.ts';

/**
 * Builds a deterministic child journal path for one nested subquery invocation.
 */
export function createSubqueryJournalPath(
  parentJournalPath: string,
  depth: number,
  queryIndex: number,
): string {
  const extension = extnameFilePath(parentJournalPath);
  const suffix = `.subquery.d${depth}.q${queryIndex}`;

  if (extension.length === 0) {
    return `${parentJournalPath}${suffix}`;
  }

  return `${parentJournalPath.slice(0, -extension.length)}${suffix}${extension}`;
}
