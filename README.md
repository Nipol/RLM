# Recursive Language Model for TypeScript

TypeScript와 Deno 환경에서 동작하는 Recursive Language Model 라이브러리입니다.

현재 구현은 다음을 제공합니다.

- persistent JavaScript/TypeScript REPL
- OpenAI Responses API 기반 RLM 실행
- `llm_query(...)`와 `rlm_query(...)`를 구분한 제어 프로토콜
- 주입 가능한 logger
- 주입 가능한 execution backend
- standalone CLI 실행

기본 execution backend는 Deno worker 기반 persistent runtime입니다.

## 핵심 개념

이 라이브러리는 모델이 일반 텍스트만 생성하는 대신, persistent REPL에서 코드를 실행하며 문제를
풉니다.

모델이 REPL 안에서 사용할 수 있는 기본 인터페이스는 다음과 같습니다.

- `context`: 외부 입력 전체
- `history`: 지금까지의 셀 실행 기록
- `FINAL(value)`: 최종 답을 종료 신호로 기록
- `FINAL_VAR(value)`: REPL 값 기반으로 최종 답을 기록
- `await llm_query(prompt)`: sub model을 사용하는 plain LM 호출
- `await rlm_query(promptOrRequest)`: child RLM 호출
- `normalizeTarget(value)`: 질문형 문자열에서 target 후보를 정규화
- `findAnchoredValue(text, prefix, suffix)`: 앞뒤 anchor 사이 값을 추출

`rlm_query(...)`는 문자열 하나를 받을 수도 있고, 구조화된 요청도 받을 수 있습니다.

```ts
await rlm_query('Return the matching vault key.');

await rlm_query({
  task: 'Return the matching vault key.',
  payload: narrowedRows,
  expect: { vaultKey: 'string' },
});
```

기본 제약은 다음과 같습니다.

- `import` / `export` 문법은 허용되지 않습니다
- 기본 backend에서는 네트워크와 임의 파일 시스템 접근이 차단됩니다
- 모델은 fenced `repl` 코드 블록을 통해서만 REPL 코드를 실행해야 합니다

## 설치와 import

패키지 import 경로는 `jsr:@yoonsung/rlm` 입니다.

```ts
import { createOpenAIRLM } from 'jsr:@yoonsung/rlm';
```

## 빠른 시작

가장 간단한 경로는 `createOpenAIRLM(...)` 입니다.

```ts
import { createOpenAIRLM, InMemoryRLMLogger } from 'jsr:@yoonsung/rlm';

const rlm = createOpenAIRLM({
  openAI: {
    apiKey: '<OPENAI_API_KEY>',
    baseUrl: 'https://api.openai.com/v1',
    requestTimeoutMs: 30_000,
    rootModel: 'gpt-5.4-mini',
    subModel: 'gpt-5.4-nano',
  },
  logger: new InMemoryRLMLogger(),
  defaults: {
    maxSteps: 12,
    maxSubcallDepth: 1,
    outputCharLimit: 4_000,
  },
});

const result = await rlm.run({
  context: {
    document: 'alpha beta gamma 비밀 코드: 731845 delta epsilon',
  },
  prompt: '문서 안에 숨겨진 6자리 코드를 찾아 숫자만 반환하세요.',
});

console.log(result.answer);
console.log(result.finalValue);
console.log(result.steps);
console.log(result.usage.totalTokens);
```

`result`에는 다음 정보가 포함됩니다.

- `answer`: 최종 답 문자열
- `finalValue`: 최종 JSON 값
- `responseId`: provider 응답 ID
- `steps`: root loop에서 사용한 turn 수
- `session`: 실행된 `ReplSession`
- `usage`: 누적 usage summary

## 라이브러리 진입점

### `createOpenAIRLM(...)`

OpenAI를 바로 사용하고 싶을 때 쓰는 provider 특화 진입점입니다.

```ts
import { createOpenAIRLM } from 'jsr:@yoonsung/rlm';

const client = createOpenAIRLM({
  openAI: {
    apiKey: '<OPENAI_API_KEY>',
    baseUrl: 'https://api.openai.com/v1',
    requestTimeoutMs: 30_000,
    rootModel: 'gpt-5.4-mini',
    subModel: 'gpt-5.4-nano',
  },
});

const result = await client.run({
  context: { question: '6 * 7' },
  prompt: '질문에 있는 계산 결과를 구하세요.',
});
```

### `createRLM(...)`

adapter를 직접 주입하고 싶을 때 쓰는 일반 진입점입니다.

````ts
import type { LLMAdapter } from 'jsr:@yoonsung/rlm';
import { createRLM } from 'jsr:@yoonsung/rlm';

const adapter: LLMAdapter = {
  async complete(_request) {
    return {
      responseId: 'mock-response',
      outputText: '```repl\nFINAL_VAR("ok")\n```',
    };
  },
};

const client = createRLM({
  adapter,
  models: {
    root: 'mock-root',
    sub: 'mock-sub',
  },
});

const result = await client.run({
  context: null,
  prompt: '즉시 완료 결과를 반환하세요.',
});

console.log(result.answer);
````

### one-shot helper

객체를 만들지 않고 한 번만 실행하고 싶다면 `runOpenAIRLM(...)` 또는 `runRLM(...)`을 사용할 수
있습니다.

```ts
import { NullRLMLogger, runOpenAIRLM } from 'jsr:@yoonsung/rlm';

const result = await runOpenAIRLM({
  openAI: {
    apiKey: '<OPENAI_API_KEY>',
    baseUrl: 'https://api.openai.com/v1',
    requestTimeoutMs: 30_000,
    rootModel: 'gpt-5.4-mini',
    subModel: 'gpt-5.4-nano',
  },
  context: { question: '6 * 7' },
  prompt: '질문에 있는 계산 결과를 구하세요.',
  logger: new NullRLMLogger(),
  maxSteps: 6,
  maxSubcallDepth: 1,
  outputCharLimit: 1_000,
});
```

권장 순서는 다음과 같습니다.

1. 재사용할 애플리케이션이면 `createOpenAIRLM(...)` 또는 `createRLM(...)`
2. 일회성 실행이면 `runOpenAIRLM(...)` 또는 `runRLM(...)`

## 프롬프트와 시스템 프롬프트

라이브러리 사용자는 보통 작업 설명만 작성하면 됩니다. REPL 프로토콜 자체는 내부 system prompt가
담당합니다.

즉 보통은 이런 문장을 직접 넣을 필요가 없습니다.

- REPL을 먼저 보라
- `FINAL_VAR(...)`를 사용하라
- `import`를 쓰지 마라
- prose를 쓰지 말고 코드 블록을 써라

라이브러리 쪽에서는 필요하면 `systemPromptExtension`으로 내부 RLM system prompt를 확장할 수
있습니다.

```ts
const result = await client.run({
  context: { document: '...' },
  prompt: '질문에 답하세요.',
  systemPromptExtension: '최종 답변은 한국어로 간결하게 작성하세요.',
});
```

`systemPromptExtension`은 내부 RLM 제어 프롬프트에 덧붙는 값입니다.

standalone CLI의 `--system-prompt`는 다른 역할을 합니다. standalone에서는 RLM이 내부적으로 답을 찾은
뒤, 그 결과를 최종 사용자 응답으로 다시 정리하는 데 사용됩니다.

## Logger 선택

기본 logger는 `InMemoryRLMLogger` 입니다.

### 메모리 기반 기록

```ts
import { createOpenAIRLM, InMemoryRLMLogger } from 'jsr:@yoonsung/rlm';

const logger = new InMemoryRLMLogger();

const client = createOpenAIRLM({
  openAI: {
    apiKey: '<OPENAI_API_KEY>',
    baseUrl: 'https://api.openai.com/v1',
    requestTimeoutMs: 30_000,
    rootModel: 'gpt-5.4-mini',
    subModel: 'gpt-5.4-nano',
  },
  logger,
});

await client.run({
  context: null,
  prompt: '즉시 완료 결과를 반환하세요.',
});

const loaded = logger.load();
console.log(loaded.session);
console.log(loaded.cells.length);
```

### 기록 비활성화

```ts
import { createOpenAIRLM, NullRLMLogger } from 'jsr:@yoonsung/rlm';

const client = createOpenAIRLM({
  openAI: {
    apiKey: '<OPENAI_API_KEY>',
    baseUrl: 'https://api.openai.com/v1',
    requestTimeoutMs: 30_000,
    rootModel: 'gpt-5.4-mini',
    subModel: 'gpt-5.4-nano',
  },
  logger: new NullRLMLogger(),
});
```

### JSONL 파일 기록

```ts
import { createOpenAIRLM, JsonlFileLogger } from 'jsr:@yoonsung/rlm';

const client = createOpenAIRLM({
  openAI: {
    apiKey: '<OPENAI_API_KEY>',
    baseUrl: 'https://api.openai.com/v1',
    requestTimeoutMs: 30_000,
    rootModel: 'gpt-5.4-mini',
    subModel: 'gpt-5.4-nano',
  },
  logger: new JsonlFileLogger('./logs/session.jsonl'),
});
```

파일 기반 기록은 standalone 실행이나 디버깅에 적합합니다.

## Execution backend 주입

기본 backend는 worker 기반 persistent runtime입니다.

```ts
import { createOpenAIRLM, WorkerExecutionBackend } from 'jsr:@yoonsung/rlm';

const client = createOpenAIRLM({
  openAI: {
    apiKey: '<OPENAI_API_KEY>',
    baseUrl: 'https://api.openai.com/v1',
    requestTimeoutMs: 30_000,
    rootModel: 'gpt-5.4-mini',
    subModel: 'gpt-5.4-nano',
  },
  executionBackend: new WorkerExecutionBackend(),
});
```

execution backend는 주입 가능한 단일 인터페이스로 유지됩니다.

## 직접 REPL만 사용할 수도 있습니다

RLM loop 없이 persistent REPL만 쓰고 싶다면 `ReplSession`을 직접 열 수 있습니다.

```ts
import { InMemoryRLMLogger, ReplSession } from 'jsr:@yoonsung/rlm';

const session = await ReplSession.open({
  context: { title: 'demo' },
  logger: new InMemoryRLMLogger(),
});

const first = await session.execute('const subtotal = 18 + 24; subtotal');
const second = await session.execute('subtotal + 8');
const third = await session.execute('FINAL_VAR(subtotal + 100)');

console.log(first.result.preview);
console.log(second.result.preview);
console.log(third.finalAnswer);

await session.close();
```

`ReplSession`은 다음 성질을 가집니다.

- 성공한 셀 상태가 다음 셀에 유지됩니다
- `context`와 `history`가 자동으로 노출됩니다
- `FINAL(...)` / `FINAL_VAR(...)`를 REPL 내부에서 호출할 수 있습니다
- `llmQueryHandler`와 `rlmQueryHandler`를 직접 주입할 수 있습니다

## standalone CLI

standalone CLI는 저장소 안에서 직접 실행하는 편의 계층입니다. 입력 파일을 `context.document`로 넣어
RLM 코어를 실행하고, 지정한 시스템 프롬프트 파일로 최종 사용자 응답을 다시 렌더링합니다.

기본 실행:

```bash
deno task standalone -- \
  --input ./book.md \
  --system-prompt ./prompts/rlm_user_answer_system.txt \
  --query "이 책에서 개헌은 어떤 맥락에 설명되고 있습니까?"
```

옵션:

- `--input <path>`: 분석할 입력 파일 경로
- `--system-prompt <path>`: 최종 사용자 응답 렌더링용 시스템 프롬프트 파일 경로
- `--query <text>`: 사용자 질문
- `--log <path>`: JSONL 로그 경로 override

standalone 실행 시 다음이 기본으로 수행됩니다.

- 입력 파일 내용을 `context.document`로 전달
- 입력 파일 절대 경로를 `context.inputFilePath`로 전달
- 기본 로그를 `logs/standalone/<timestamp>.jsonl`에 기록
- step, cell, subquery 진행 상황을 실시간 출력
- 내부 RLM 결과를 바탕으로 `[final] ...` 형태의 최종 사용자 응답 출력

standalone의 `--system-prompt`는 내부 RLM 제어 프롬프트가 아니라, RLM이 찾아낸 결과를 사용자에게
어떻게 답할지를 정의하는 파일입니다.

### standalone 환경 변수

standalone는 `.env`를 통해 OpenAI 설정을 읽을 수 있습니다.

`.env.example` 형식:

```dotenv
OPENAI_API_KEY=
RLM_OPENAI_ROOT_MODEL=
RLM_OPENAI_SUB_MODEL=

# Optional overrides
# RLM_OPENAI_BASE_URL=https://api.openai.com/v1
# RLM_REQUEST_TIMEOUT_MS=30000
# RLM_MAX_STEPS=12
# RLM_MAX_SUBCALL_DEPTH=3
# RLM_MAX_OUTPUT_CHARS=4000
```

라이브러리 사용에는 `.env`가 필수가 아닙니다. `.env`는 standalone 실행이나 로컬 편의 경로에 주로
사용됩니다.

## 테스트

기본 테스트:

```bash
deno task test
```

커버리지:

```bash
deno task coverage
```

실제 OpenAI 연동 테스트:

```bash
deno task test:openai
```

실제 OpenAI 연동 테스트는 단일 진입점 `tests/openai_live_test.ts`를 사용합니다.

필요하면 filter로 integration/synthetic만 따로 실행할 수 있습니다.

```bash
deno task test:openai:integration
deno task test:openai:synthetic
```

long-context 벤치:

```bash
deno task test:openai:long-context
```

## 공개 API

주요 공개 API는 다음과 같습니다.

- `createOpenAIRLM`
- `createRLM`
- `runOpenAIRLM`
- `runRLM`
- `ReplSession`
- `InMemoryRLMLogger`
- `NullRLMLogger`
- `JsonlFileLogger`
- `WorkerExecutionBackend`
- `loadRLMConfig`
- `parseStandaloneCLIArgs`
- `resolveStandaloneCLIOptions`
- `runStandaloneCLI`

파서, adapter, 타입, usage helper도 `jsr:@yoonsung/rlm`에서 함께 export 됩니다.
