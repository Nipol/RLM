import assert from 'node:assert/strict';

import {
  createSubqueryLogger,
  InMemoryRLMLogger,
  JsonlFileLogger,
  NullRLMLogger,
  resolveRLMLogger,
} from '../src/logger.ts';

Deno.test('logger helpers reject conflicting inputs and preserve null logger subqueries', () => {
  const logger = new InMemoryRLMLogger();

  assert.throws(
    () =>
      resolveRLMLogger({
        journalPath: '/tmp/session.jsonl',
        logger,
      }),
    /either logger or journalPath/u,
  );

  const nullChild = createSubqueryLogger(new NullRLMLogger(), 1, 0);
  assert.ok(nullChild instanceof NullRLMLogger);

  const memoryChild = createSubqueryLogger(logger, 1, 0);
  assert.ok(memoryChild instanceof InMemoryRLMLogger);

  const fileChild = createSubqueryLogger(new JsonlFileLogger('/tmp/session.jsonl'), 2, 3);
  assert.ok(fileChild instanceof JsonlFileLogger);
  assert.equal(
    (fileChild as JsonlFileLogger).path,
    '/tmp/session.subquery.d2.q3.jsonl',
  );
});
