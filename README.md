# Recursive Language Model for TypeScript

TypeScript와 Deno 환경에서 동작하는 Recursive Language Model 라이브러리입니다.

현재 구현은 다음을 제공합니다.

- persistent JavaScript/TypeScript REPL
- 외부 LLM caller 주입 기반 RLM 실행
- 포함된 provider 예시:
  - OpenAI Responses API
  - Codex OAuth
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
import { createRLM } from 'jsr:@yoonsung/rlm';
```

## 라이브러리 구조

이 패키지는 특정 provider에 고정된 SDK가 아니라, 외부 LLM 호출 동작을 주입받아 실행하는
library-first RLM 코어입니다.

핵심 구성은 다음과 같습니다.

- RLM core:
  - system prompt 구성
  - root/child/plain query orchestration
  - REPL protocol 파싱
  - `llm_query(...)` / `rlm_query(...)` 제어
- `LLMCaller`:
  - core가 한 번의 LLM 호출을 요청할 때 사용하는 최소 인터페이스
- `LLMProvider`:
  - 필요하면 config로부터 `LLMCaller`를 만들어 주는 factory 인터페이스
- 포함된 provider 예시:
  - `OpenAIResponsesProvider`
  - `CodexOAuthProvider`

즉 라이브러리의 기본 사용 방식은 다음 둘 중 하나입니다.

1. 이미 준비된 LLM 호출 함수를 `createRLM(...)`에 직접 주입
2. provider가 `createCaller(...)`로 만든 caller를 `createRLM(...)`에 주입

`createOpenAIRLM(...)`은 이 일반 구조 위에 얹혀 있는 OpenAI 편의 진입점입니다.

## 외부 LLM 주입

라이브러리를 일반적으로 사용할 때는 `createRLM(...)`과 `LLMCaller`를 기준으로 보면 됩니다.

````ts
import type { LLMCaller } from 'jsr:@yoonsung/rlm';
import { createRLM } from 'jsr:@yoonsung/rlm';

const llm: LLMCaller = {
  async complete(_request) {
    return {
      outputText: '```repl\nFINAL_VAR("ok")\n```',
      turnState: { opaque: 'mock-state' },
    };
  },
};

const client = createRLM({
  llm,
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

이 경로에서는 호출 대상이 OpenAI인지, 사내 gateway인지, OAuth 기반 provider인지와 무관하게 core는
동일하게 동작합니다.

## `LLMCaller`와 `LLMProvider`

직접 caller나 provider를 만들 때 core가 요구하는 최소 계약은 `LLMCaller`입니다.

````ts
import type {
  LLMCaller,
  LLMCallerRequest,
  LLMCallerResponse,
  LLMProvider,
} from 'jsr:@yoonsung/rlm';

const llm: LLMCaller = {
  async complete(request: LLMCallerRequest): Promise<LLMCallerResponse> {
    return {
      outputText: '```repl\nFINAL_VAR("ok")\n```',
      turnState: { opaqueCursor: 'next' },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    };
  },
};
````

`LLMCallerRequest`에는 다음 정보가 들어옵니다.

- `input`: 이번 model 호출의 user input
- `systemPrompt`: core가 만든 system prompt
- `model`: 이번 호출에 사용할 model id
- `kind`: `root_turn` | `child_turn` | `plain_query`
- `metadata`: depth, step, queryIndex 같은 실행 메타데이터
- `turnState`: provider가 이전 호출에서 돌려준 opaque continuation state
- `signal`: 취소 전파용 `AbortSignal`

`LLMCallerResponse`는 다음 값만 반환하면 됩니다.

- `outputText`: model의 최종 text output
- `turnState?`: 다음 호출에 그대로 다시 받을 provider 전용 state
- `usage?`: token usage 요약

핵심 책임 분리는 다음과 같습니다.

- core:
  - system prompt 구성
  - root/child/plain query orchestration
  - REPL protocol 파싱
  - `llm_query(...)` / `rlm_query(...)` 제어
- caller/provider:
  - 인증
  - SDK 또는 HTTP transport
  - provider별 request body 구성
  - 재시도와 timeout
  - provider-specific model catalog 검증

즉 core는 특정 provider를 알지 않고, caller/provider는
`LLMCallerRequest -> provider request -> LLMCallerResponse` 변환만 책임집니다.

factory 형태가 편하면 `LLMProvider`를 구현하면 됩니다.

```ts
import type { LLMCaller, LLMProvider } from 'jsr:@yoonsung/rlm';

interface ExampleProviderConfig {
  token: string;
}

class ExampleProvider implements LLMProvider<ExampleProviderConfig> {
  createCaller(config: ExampleProviderConfig): LLMCaller {
    return {
      async complete(request) {
        const responseText = `echo:${config.token}:${request.input}`;
        return {
          outputText: `\`\`\`repl\nFINAL_VAR(${JSON.stringify(responseText)})\n\`\`\``,
        };
      },
    };
  }
}
```

이렇게 만든 caller는 `createRLM(...)`에 바로 주입할 수 있습니다.

```ts
import { createRLM } from 'jsr:@yoonsung/rlm';

const provider = new ExampleProvider();

const client = createRLM({
  llm: provider.createCaller({ token: 'demo-token' }),
  models: {
    root: 'example-root',
    sub: 'example-sub',
  },
});
```

## 포함된 provider 예시

현재 공개 export에는 다음 provider가 포함되어 있습니다.

- `OpenAIResponsesProvider`
- `CodexOAuthProvider`

이 둘은 현재 저장소에 포함된 예시 구현이며, `createRLM(...)`이 요구하는 일반 인터페이스를 따르는
구체 provider입니다.

## 빠른 시작

가장 일반적인 빠른 시작은 `createRLM(...)`으로 외부 caller를 주입하는 방식입니다.

````ts
import type { LLMCaller } from 'jsr:@yoonsung/rlm';
import { createRLM, InMemoryRLMLogger } from 'jsr:@yoonsung/rlm';

const llm: LLMCaller = {
  async complete(_request) {
    return {
      outputText: '```repl\nFINAL_VAR("731845")\n```',
    };
  },
};

const rlm = createRLM({
  llm,
  models: {
    root: 'demo-root',
    sub: 'demo-sub',
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
````

OpenAI를 바로 연결하고 싶다면 아래의 OpenAI 편의 진입점도 사용할 수 있습니다.

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
```

`result`에는 다음 정보가 포함됩니다.

- `answer`: 최종 답 문자열
- `finalValue`: 최종 JSON 값
- `steps`: root loop에서 사용한 turn 수
- `session`: 실행된 `ReplSession`
- `usage`: 누적 usage summary

## 라이브러리 진입점

### `createRLM(...)`

외부에서 준비한 LLM caller를 직접 주입하고 싶을 때 쓰는 일반 진입점입니다.

````ts
import type { LLMCaller } from 'jsr:@yoonsung/rlm';
import { createRLM } from 'jsr:@yoonsung/rlm';

const llm: LLMCaller = {
  async complete(_request) {
    return {
      outputText: '```repl\nFINAL_VAR("ok")\n```',
      turnState: { opaque: 'mock-state' },
    };
  },
};

const client = createRLM({
  llm,
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

### `createOpenAIRLM(...)`

포함된 provider 예시 중 OpenAI Responses API를 바로 사용하고 싶을 때 쓰는 provider 특화
진입점입니다.

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

### 사용할 수 있는 `LLMProvider`

현재 공개 export에는 다음 provider가 포함되어 있습니다.

#### `OpenAIResponsesProvider`

일반 OpenAI Responses API를 사용할 때 쓰는 provider입니다.

- 인증: API key
- transport: `https://api.openai.com/v1/responses`
- caller 생성 입력:
  - `apiKey`
  - `baseUrl`
  - `requestTimeoutMs`
  - `rootModel`
  - `subModel`

```ts
import { createRLM, OpenAIResponsesProvider } from 'jsr:@yoonsung/rlm';

const provider = new OpenAIResponsesProvider();

const client = createRLM({
  llm: provider.createCaller({
    apiKey: '<OPENAI_API_KEY>',
    baseUrl: 'https://api.openai.com/v1',
    requestTimeoutMs: 30_000,
    rootModel: 'gpt-5.4-mini',
    subModel: 'gpt-5.4-nano',
  }),
  models: {
    root: 'gpt-5.4-mini',
    sub: 'gpt-5.4-nano',
  },
});
```

#### `CodexOAuthProvider`

ChatGPT Codex OAuth 세션을 사용하는 provider입니다.

- 인증: interactive OAuth login 후 저장된 세션 재사용
- transport:
  - `https://auth.openai.com/oauth/...`
  - `https://chatgpt.com/backend-api/codex/models?client_version=1.0.0`
  - `https://chatgpt.com/backend-api/codex/responses`
- 세션 저장 위치: `.rlm/codex-oauth.json`
- caller 생성 입력:
  - `requestTimeoutMs`

`CodexOAuthProvider`는 먼저 로그인이나 기존 세션이 필요합니다.

```ts
import { CodexOAuthProvider, createRLM } from 'jsr:@yoonsung/rlm';

const provider = new CodexOAuthProvider();

await provider.login();

const availableModels = await provider.listModels();
const llm = provider.createCaller({
  requestTimeoutMs: 30_000,
});

const client = createRLM({
  llm,
  models: {
    root: availableModels[0]!,
    sub: availableModels[0]!,
  },
});
```

Codex OAuth에서는 model id를 임의 문자열로 만들지 않고, `listModels()`가 돌려준 exact id를 사용하는
것이 권장됩니다.

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

1. 재사용할 애플리케이션이면 `createRLM(...)`
2. 포함된 OpenAI 편의 경로가 맞다면 `createOpenAIRLM(...)`
3. 일회성 실행이면 `runRLM(...)` 또는 `runOpenAIRLM(...)`

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

### 실행 모드

#### 1. 문서 질의 실행

기본 실행은 입력 파일, 사용자 질의, 최종 응답용 시스템 프롬프트 파일을 받아 RLM을 한 번 실행합니다.

```bash
deno task standalone -- \
  --input ./book.md \
  --system-prompt ./prompts/rlm_user_answer_system.txt \
  --query "Chapter Three의 핵심 내용은 무엇입니까?"
```

#### 2. Codex OAuth 로그인

Codex OAuth provider를 쓰려면 먼저 로그인할 수 있습니다.

```bash
deno task standalone -- \
  --provider codex-oauth \
  --login
```

로그인 후에는 모델 목록도 바로 출력됩니다.

#### 3. 사용 가능한 모델 목록 조회

현재 provider에서 보이는 모델 id를 보고 싶으면 `--list-models`를 사용합니다.

```bash
deno task standalone -- \
  --provider codex-oauth \
  --list-models
```

### standalone에서 선택 가능한 provider

#### `openai`

- 기본 provider
- `.env` 또는 명시적 OpenAI 설정을 사용
- 일반 OpenAI Responses API 경로를 사용

#### `codex-oauth`

- 로그인 후 저장된 OAuth 세션을 사용
- Codex 전용 모델 목록과 Codex 응답 경로를 사용
- 모델 override는 현재 세션에서 보이는 exact model id만 허용

### 주요 옵션

#### 공통 실행 옵션

- `--provider <openai|codex-oauth>`: standalone 실행 provider 선택. 기본값은 `openai`
- `--input <path>`: 분석할 입력 파일 경로
- `--system-prompt <path>`: 최종 사용자 응답 렌더링용 시스템 프롬프트 파일 경로
- `--query <text>`: 사용자 질문
- `--log <path>`: JSONL 로그 경로 override
- `--request-timeout-ms <ms>`: provider 내부 LLM 요청 timeout override
- `--cell-timeout-ms <ms>`: provider 요청 timeout에 더할 추가 REPL 셀 여유 시간
- `--root-model <model>`: standalone root model override
- `--sub-model <model>`: standalone sub model override

#### Codex OAuth 전용 옵션

- `--login`: Codex OAuth 로그인 수행 후 저장된 인증 상태를 갱신
- `--list-models`: 현재 provider에서 사용 가능한 모델 목록 출력

### 실행 시 기본 동작

- 입력 파일 내용을 `context.document`로 전달
- 입력 파일 절대 경로를 `context.inputFilePath`로 전달
- 기본 로그를 `logs/standalone/<timestamp>.jsonl`에 기록
- step, cell, subquery 진행 상황을 실시간 출력
- 내부 RLM 결과를 바탕으로 `[final] ...` 형태의 최종 사용자 응답 출력
- 실행 종료 시 총 입력/출력 토큰과 달러 기준 비용 요약 출력

### 셀 타임아웃 권장값

- 총 셀 타임아웃은 `provider request timeout + 추가 셀 여유 시간`으로 계산됩니다.
- `RLM_REQUEST_TIMEOUT_MS` 또는 `--request-timeout-ms`는 provider 내부 LLM 요청 timeout입니다.
- 기본 추가 셀 여유 시간은 `5_000ms`입니다.
- 기본 OpenAI/Codex standalone 경로에서는 보통 총 `35_000ms`가 사용됩니다.
- OCR된 장문 문서나 `llm_query(...)`가 들어가는 셀은 `45_000ms`~`60_000ms`가 더 안정적일 수
  있습니다.
- `--cell-timeout-ms`를 주면 provider timeout에 더할 추가 시간으로 사용합니다.

### `--system-prompt`의 의미

standalone의 `--system-prompt`는 내부 RLM 제어 프롬프트가 아닙니다. RLM이 내부적으로 찾은 결과를
사용자에게 어떤 형식과 톤으로 다시 답할지를 정의하는 최종 응답 렌더링용 프롬프트입니다.

### Codex OAuth 세션 동작

Codex OAuth provider를 사용할 때는 인증 상태가 워크스페이스의 `.rlm/codex-oauth.json`에 저장됩니다.
한 번 로그인한 뒤에는 해당 파일을 재사용해 모델 목록 조회와 실제 실행에 사용합니다. 브라우저가 로컬
HTTP callback 응답을 완료하지 못하는 환경에서는 로그인 진행 중 같은 터미널에 최종 리다이렉트 URL
전체를 붙여넣어 로그인 절차를 마칠 수 있습니다.

### standalone 환경 변수

standalone의 `.env`는 세 종류로 사용됩니다.

- OpenAI provider 경로: API key, model
- OpenAI/Codex 공통 provider 경로: request timeout
- OpenAI/Codex 공통 runtime 경로: step 제한, 출력 길이, 추가 셀 여유 시간

`.env.example` 형식:

```dotenv
OPENAI_API_KEY=
RLM_OPENAI_ROOT_MODEL=
RLM_OPENAI_SUB_MODEL=

# Optional overrides
# RLM_OPENAI_BASE_URL=https://api.openai.com/v1
# RLM_REQUEST_TIMEOUT_MS=30000
# RLM_CELL_TIMEOUT_MS=5000
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

파서, caller/provider 타입, usage helper도 `jsr:@yoonsung/rlm`에서 함께 export 됩니다.
