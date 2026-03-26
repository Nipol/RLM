import assert from 'node:assert/strict';

import {
  extractFinalSignal,
  extractReplCodeBlocks,
} from '../src/repl_protocol.ts';

Deno.test('repl protocol extractor keeps only repl fences and preserves source order', () => {
  const blocks = extractReplCodeBlocks(`
Before

\`\`\`typescript
const ignored = true;
\`\`\`

\`\`\`repl
const subtotal = 40 + 2;
\`\`\`

Middle

\`\`\`repl
FINAL_VAR(subtotal);
\`\`\`
`);

  assert.deepEqual(blocks, [
    {
      code: 'const subtotal = 40 + 2;',
      fenceLabel: 'repl',
      index: 0,
    },
    {
      code: 'FINAL_VAR(subtotal);',
      fenceLabel: 'repl',
      index: 1,
    },
  ]);
});

Deno.test('repl protocol extractor accepts repl fences with extra fence metadata and FINAL_VAR fallbacks', () => {
  const blocks = extractReplCodeBlocks(`
\`\`\`repl javascript
FINAL_VAR(answer);
\`\`\`
`);
  const signal = extractFinalSignal('Done. FINAL_VAR(answer)');

  assert.deepEqual(blocks, [
    {
      code: 'FINAL_VAR(answer);',
      fenceLabel: 'repl',
      index: 0,
    },
  ]);
  assert.deepEqual(signal, {
    kind: 'FINAL_VAR',
    value: 'answer',
  });
});

Deno.test('repl protocol extractor ignores malformed or unterminated fences instead of crashing the loop', () => {
  const blocks = extractReplCodeBlocks(`
\`\`\`repl
const answer = 42;
`);

  assert.deepEqual(blocks, []);
});

Deno.test('repl protocol extractor ignores unlabeled fences that do not opt into repl execution', () => {
  const blocks = extractReplCodeBlocks(`
\`\`\`
const answer = 42;
\`\`\`
`);

  assert.deepEqual(blocks, []);
});

Deno.test('final signal extractor finds explicit FINAL calls in assistant text fallbacks', () => {
  const signal = extractFinalSignal('I am done. FINAL("answer complete")');

  assert.deepEqual(signal, {
    kind: 'FINAL',
    value: '"answer complete"',
  });
});

Deno.test('final signal extractor ignores casual prose that only resembles a final call', () => {
  const signal = extractFinalSignal('the word final(answer) appears here in lowercase');

  assert.equal(signal, null);
});
