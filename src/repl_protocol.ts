/**
 * Describes one executable `repl` code fence extracted from assistant text.
 *
 * @example
 * ```ts
 * const [block] = extractReplCodeBlocks('```repl\nFINAL_VAR(42)\n```');
 * console.log(block.code);
 * ```
 */
export interface ReplCodeBlock {
  code: string;
  fenceLabel: string;
  index: number;
}

/**
 * Describes a terminal `FINAL(...)` or `FINAL_VAR(...)` marker parsed from text.
 *
 * @example
 * ```ts
 * const signal = extractFinalSignal('FINAL("done")');
 * console.log(signal?.kind);
 * ```
 */
export interface FinalSignal {
  kind: 'FINAL' | 'FINAL_VAR';
  value: string;
}

/**
 * Extracts executable `repl` fences from assistant text in source order.
 */
function readFenceLabel(rawFenceLabel: string): string {
  const trimmed = rawFenceLabel.trim();
  if (trimmed.length === 0) {
    return '';
  }

  return trimmed.split(/\s+/u, 1)[0];
}

/**
 * Extracts executable `repl` fences from assistant text in source order.
 *
 * @example
 * ```ts
 * const blocks = extractReplCodeBlocks(`
 * Before code.
 * \`\`\`repl
 * const answer = 6 * 7;
 * FINAL_VAR(answer);
 * \`\`\`
 * `);
 * ```
 */
export function extractReplCodeBlocks(text: string): ReplCodeBlock[] {
  const matches = text.matchAll(/```([^\n\r`]*)\r?\n([\s\S]*?)\r?\n```/gu);
  const blocks: ReplCodeBlock[] = [];
  let index = 0;

  for (const match of matches) {
    const fenceLabel = readFenceLabel(match[1]);
    if (fenceLabel !== 'repl') {
      continue;
    }

    blocks.push({
      code: match[2].trim(),
      fenceLabel,
      index,
    });
    index += 1;
  }

  return blocks;
}

/**
 * Extracts the first explicit final marker from assistant text when no code fences are present.
 *
 * @example
 * ```ts
 * const signal = extractFinalSignal('FINAL_VAR("ok")');
 * console.log(signal?.value);
 * ```
 */
export function extractFinalSignal(text: string): FinalSignal | null {
  const match = text.match(/\b(FINAL_VAR|FINAL)\(([\s\S]*?)\)/u);
  if (match === null) {
    return null;
  }

  return {
    kind: match[1] as FinalSignal['kind'],
    value: match[2].trim(),
  };
}
