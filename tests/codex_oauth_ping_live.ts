import assert from 'node:assert/strict';

import { CodexOAuthProvider } from '../src/providers/codex_oauth.ts';

interface CodexPingResult {
  model: string;
  output?: string;
  success: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  error?: string;
}

const CODEx_PING_SYSTEM_PROMPT =
  'If you receive the exact message "ping", respond with exactly PONG and nothing else.';
const CODEx_PING_INPUT = 'ping';

function formatCodexPingSummary(results: CodexPingResult[]): string {
  return results.map((result) => {
    if (result.success) {
      const usage = result.usage === undefined
        ? ''
        : ` tokens=${result.usage.totalTokens ?? '?'}(in:${result.usage.inputTokens ?? '?'} out:${
          result.usage.outputTokens ?? '?'
        })`;
      return `${result.model}: ok output=${JSON.stringify(result.output ?? '')}${usage}`;
    }

    return `${result.model}: fail ${result.error ?? 'unknown error'}`;
  }).join('\n');
}

Deno.test(
  'Codex OAuth catalog models respond to ping with exactly PONG',
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    const provider = new CodexOAuthProvider();
    const models = await provider.listModels();

    assert.ok(models.length > 0, 'Codex OAuth did not return any models.');

    const caller = provider.createCaller({
      requestTimeoutMs: 30_000,
    });

    const results: CodexPingResult[] = [];

    for (const model of models) {
      console.log(`[codex-ping] model=${model} status=running`);
      try {
        const completion = await caller.complete({
          input: CODEx_PING_INPUT,
          kind: 'plain_query',
          metadata: { depth: 0, queryIndex: 0 },
          model,
          systemPrompt: CODEx_PING_SYSTEM_PROMPT,
        });
        const output = completion.outputText.trim();
        const success = output === 'PONG';
        results.push({
          model,
          output,
          success,
          usage: completion.usage === undefined ? undefined : {
            inputTokens: completion.usage.inputTokens,
            outputTokens: completion.usage.outputTokens,
            totalTokens: completion.usage.totalTokens,
          },
        });
        console.log(
          `[codex-ping] model=${model} status=${success ? 'ok' : 'bad-output'} output=${
            JSON.stringify(output)
          }`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          error: message,
          model,
          success: false,
        });
        console.log(`[codex-ping] model=${model} status=error message=${message}`);
      }
    }

    const failures = results.filter((result) => !result.success);
    assert.equal(
      failures.length,
      0,
      [
        'Some Codex OAuth catalog models did not answer PONG.',
        formatCodexPingSummary(results),
      ].join('\n'),
    );
  },
);
