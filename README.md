# Recursive Language Model for TypeScript

TypeScript로 작성된 Recursive Language Model 라이브러리입니다.

현재 구현은 다음을 제공합니다.

- persistent JavaScript/TypeScript REPL
- 외부 LLM caller 주입 기반 RLM 실행
- full package에 포함된 provider 예시:
  - OpenAI Responses API
  - Ollama generate API
  - Codex OAuth
- `llm_query(...)`와 `rlm_query(...)`를 구분한 제어 프로토콜
- 선택적 evaluator model
- 주입 가능한 logger
- 주입 가능한 execution backend
- `examples/` 아래의 예제
- browser-safe core / provider ESM build

기본 execution backend는 worker 기반 persistent runtime입니다.

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

provider와 무관한 core만 사용하려면 `jsr:@yoonsung/rlm/core` subpath를 사용할 수 있습니다.

```ts
import { createRLM } from 'jsr:@yoonsung/rlm/core';
```

provider 전용 진입점은 다음 subpath를 사용합니다.

- `jsr:@yoonsung/rlm/providers/openai`
- `jsr:@yoonsung/rlm/providers/ollama`
- `jsr:@yoonsung/rlm/providers/codex-oauth`

루트 entrypoint는 provider 특화 helper와 pricing helper를 재수출하지 않습니다.

## Core ESM build

browser와 일반 Node ESM 소비를 위해 browser-safe ESM bundle을 만들 수 있습니다.

```bash
deno task build:core
```

빌드 결과는 다음 경로에 생성됩니다.

- `dist/core/index.mjs`
- `dist/providers/openai/index.mjs`
- `dist/providers/ollama/index.mjs`
- `dist/plugin/aot/index.mjs`
- `dist/plugin/pingpong/index.mjs`

이 산출물에는 browser-safe entrypoint만 포함됩니다.

- 포함:
  - `createRLM(...)`
  - `runRLM(...)`
  - `ReplSession`
  - `WorkerExecutionBackend`
  - `InMemoryRLMLogger`
  - `NullRLMLogger`
  - OpenAI / Ollama provider bundle
- 제외:
  - standalone CLI
  - Codex OAuth provider

즉 `dist/core/index.mjs`와 `dist/providers/*/index.mjs`는 browser-safe 배포물이고, standalone과
`dist/plugin/*/index.mjs`도 browser-safe 배포물이며, standalone과 Codex OAuth는 full
package/source 경로에서 계속 사용합니다.

Node ESM에서는 다음처럼 직접 import할 수 있습니다.

```js
import { createRLM } from './dist/core/index.mjs';
import { createOpenAIRLM } from './dist/providers/openai/index.mjs';
import { createOllamaRLM } from './dist/providers/ollama/index.mjs';
import { createAoTPlugin } from './dist/plugin/aot/index.mjs';
import { createPingPongPlugin } from './dist/plugin/pingpong/index.mjs';
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
  - `OllamaGenerateProvider`
  - `CodexOAuthProvider`

라이브러리의 기본 사용 방식은 다음 둘 중 하나입니다.

1. 이미 준비된 LLM 호출 함수를 `createRLM(...)`에 직접 주입
2. provider가 `createCaller(...)`로 만든 caller를 `createRLM(...)`에 주입

`createOpenAIRLM(...)`, `runOpenAIRLM(...)`, `createOllamaRLM(...)`, `runOllamaRLM(...)`은 이 일반
구조 위에 얹혀 있는 provider 편의 진입점입니다.

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
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    };
  },
};

const client = createRLM({
  llm,
  models: {
    root: 'mock-root',
    sub: 'mock-sub',
  },
  systemPromptExtension: '최종 답변은 한 줄로 유지하세요.',
});

const result = await client.run({
  context: {
    document: 'alpha beta gamma 비밀 코드: 731845 delta epsilon',
  },
  prompt: '문서 안에 숨겨진 6자리 코드를 찾아 숫자만 반환하세요.',
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
} from 'jsr:@yoonsung/rlm/core';

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
import type { LLMCaller, LLMProvider } from 'jsr:@yoonsung/rlm/core';

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
import { createRLM } from 'jsr:@yoonsung/rlm/core';

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

이 저장소에는 다음 provider 예시 구현이 포함되어 있습니다.

- `OpenAIResponsesProvider`
- `OllamaGenerateProvider`
- `CodexOAuthProvider`

이 셋은 `createRLM(...)`이 요구하는 일반 인터페이스를 따르는 구체 provider입니다.

### `OpenAIResponsesProvider`

일반 OpenAI Responses API를 사용할 때 쓰는 provider입니다.

- subpath:
  - `jsr:@yoonsung/rlm/providers/openai`
- 인증:
  - API key
- transport:
  - `${baseUrl}/responses`
- caller 생성 입력:
  - `apiKey`
  - `baseUrl`
  - `requestTimeoutMs`
  - `rootModel`
  - `subModel`
  - `rootReasoningEffort?`
  - `subReasoningEffort?`

```ts
import { createRLM } from 'jsr:@yoonsung/rlm/core';
import { OpenAIResponsesProvider } from 'jsr:@yoonsung/rlm/providers/openai';

const provider = new OpenAIResponsesProvider();

const client = createRLM({
  llm: provider.createCaller({
    apiKey: '<OPENAI_API_KEY>',
    baseUrl: 'https://api.openai.com/v1',
    requestTimeoutMs: 30_000,
    rootModel: 'gpt-5.4-mini',
    rootReasoningEffort: 'medium',
    subModel: 'gpt-5.4-mini',
    subReasoningEffort: 'low',
  }),
  models: {
    root: 'gpt-5.4-mini',
    sub: 'gpt-5.4-mini',
  },
});
```

OpenAI provider 전용 convenience entrypoint도 함께 제공됩니다.

```ts
import { createOpenAIRLM } from 'jsr:@yoonsung/rlm/providers/openai';

const client = createOpenAIRLM({
  openAI: {
    apiKey: '<OPENAI_API_KEY>',
    baseUrl: 'https://api.openai.com/v1',
    requestTimeoutMs: 30_000,
    rootModel: 'gpt-5.4-mini',
    rootReasoningEffort: 'medium',
    subModel: 'gpt-5-mini',
    subReasoningEffort: 'low',
  },
  defaults: {
    cellTimeoutMs: 5_000,
    maxSteps: 12,
    maxSubcallDepth: 3,
    outputCharLimit: 4_000,
  },
});
```

비용 추정 helper는 같은 subpath에 있습니다.

- `estimateOpenAIUsageCostUsd(...)`
- `estimateOpenAIRunCostUsd(...)`
- `resolveOpenAITextModelPricing(...)`

### `OllamaGenerateProvider`

Ollama generate endpoint를 사용할 때 쓰는 provider입니다.

- subpath:
  - `jsr:@yoonsung/rlm/providers/ollama`
- transport:
  - `${baseUrl}/generate`
- caller 생성 입력:
  - `baseUrl`
  - `requestTimeoutMs`
  - `rootModel`
  - `subModel`
  - `keepAlive?`

```ts
import { createOllamaRLM } from 'jsr:@yoonsung/rlm/providers/ollama';

const client = createOllamaRLM({
  ollama: {
    baseUrl: 'http://127.0.0.1:11434/api',
    requestTimeoutMs: 45_000,
    rootModel: 'qwen2.5-coder:14b',
    subModel: 'qwen2.5-coder:7b',
    keepAlive: '30m',
  },
});
```

### `CodexOAuthProvider`

ChatGPT Codex OAuth 세션을 사용하는 provider입니다.

- subpath:
  - `jsr:@yoonsung/rlm/providers/codex-oauth`
- 인증:
  - interactive OAuth login 후 저장된 세션 재사용
- 세션 저장 위치:
  - `.rlm/codex-oauth.json`
- caller 생성 입력:
  - `requestTimeoutMs`

`CodexOAuthProvider`는 먼저 로그인이나 기존 세션이 필요합니다.

```ts
import { CodexOAuthProvider } from 'jsr:@yoonsung/rlm/providers/codex-oauth';
import { createRLM } from 'jsr:@yoonsung/rlm/core';

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

## 실행 옵션

`createRLM(...)`과 provider convenience client는 기본 실행 제약과 프롬프트 확장을 받을 수 있습니다.

- `defaults.cellTimeoutMs`
- `defaults.maxSteps`
- `defaults.maxSubcallDepth`
- `defaults.outputCharLimit`
- `systemPromptExtension`
- `evaluator`

```ts
import { createRLM } from 'jsr:@yoonsung/rlm/core';

const client = createRLM({
  llm,
  models: {
    root: 'demo-root',
    sub: 'demo-sub',
  },
  defaults: {
    cellTimeoutMs: 8_000,
    maxSteps: 12,
    maxSubcallDepth: 2,
    outputCharLimit: 4_000,
  },
  systemPromptExtension: '최종 답변은 한국어로 작성하세요.',
  evaluator: {
    enabled: true,
    model: 'demo-evaluator',
    maxFeedbackChars: 240,
  },
});
```

`systemPromptExtension`은 내부 RLM system prompt 뒤에 덧붙는 확장 프롬프트입니다.

## 플러그인

플러그인은 RLM runtime에 추가되는 helper와 system prompt 문구 묶음입니다. 현재 public surface에서는
`RLMPlugin`을 `createRLM(...)`의 `plugins` 또는 `client.run(...)`의 `plugins`로 전달할 수 있습니다.

- `RLMPlugin`
  - `name`
  - `runtimeHelpers?`
  - `systemPromptBlocks?`
- `RLMRuntimeHelper`
  - `name`
  - `description`
  - `source`
  - `inputKinds?`
  - `promptBlock?`
  - `signature?`
  - `returns?`
  - `examples?`
  - `timeoutMs?`
  - `rlmQueryMaxSteps?`
  - `rlmQueryMaxSubcallDepth?`

runtime helper는 REPL의 top-level binding으로 주입되고, helper 설명은 system prompt에 함께 합쳐집니다.

```ts
import {
  createRLM,
  serializeRuntimeHelperSource,
  type RLMPlugin,
  type RLMRuntimeHelperGlobals,
} from 'jsr:@yoonsung/rlm';

declare const llm_query: RLMRuntimeHelperGlobals['llm_query'];

async function summarizeText(input: string) {
  return await llm_query(`Summarize the following text:\n${input}`);
}

const summarizePlugin: RLMPlugin = {
  name: 'summarize',
  systemPromptBlocks: [
    '필요하면 `summarize_text(input)`를 사용해 긴 텍스트를 먼저 줄인 뒤 답하십시오.',
  ],
  runtimeHelpers: [{
    name: 'summarize_text',
    description: '긴 텍스트를 한 번 요약합니다.',
    inputKinds: ['text'],
    source: serializeRuntimeHelperSource({
      entrypoint: 'summarizeText',
      functions: [summarizeText],
    }),
  }],
};

const client = createRLM({
  llm,
  models: {
    root: 'demo-root',
    sub: 'demo-sub',
  },
  plugins: [summarizePlugin],
});
```

플러그인 개발 시 현재 런타임 제약은 다음과 같습니다.

- helper `source`는 sandbox worker 안에서 실행되는 순수 JavaScript여야 합니다.
- helper `source`에는 `import`와 `export`를 사용할 수 없습니다.
- helper 본문 안에서는 `input`이 예약 바인딩이며, 기본 helper 이름과 충돌하는 이름은 사용할 수 없습니다.
- helper 본문 안에서는 `llm_query(...)`, `rlm_query(...)`, `grep(...)`, `context`, `history`를 그대로 사용할 수 있습니다.
- `inputKinds`를 지정하지 않으면 입력은 기본적으로 `['text']`입니다.
- `object`와 `array` 입력은 helper가 해당 타입을 명시적으로 선언한 경우에만 허용됩니다.
- 문자열 계열 입력은 비어 있지 않은 문자열이어야 합니다.
- helper 내부 `rlm_query(...)`의 기본값은 `maxSteps = Number.POSITIVE_INFINITY`, `maxSubcallDepth = 1`입니다.
- helper timeout이 지정되면 그 값은 outer cell timeout floor로도 반영됩니다.
- 긴 helper는 raw string보다 `serializeRuntimeHelperSource(...)`로 named function 집합을 직렬화하는 방식이 유지보수에 유리합니다.
- `promptBlock`과 `systemPromptBlocks`는 실제 helper 동작과 일치하게 유지해야 합니다.

### 빌드된 core에서 플러그인 개발과 로드

이미 `deno task build:core`를 실행해 `dist/` 산출물이 준비된 경우에도, custom 플러그인은 별도 모듈로
작성해 `dist/core/index.mjs`에 바로 연결할 수 있습니다. 이 경우 저장소의 `plugin/` 디렉토리를 수정할
필요는 없습니다.

일반적인 흐름은 다음과 같습니다.

1. 애플리케이션 쪽에 custom plugin 모듈을 하나 둡니다.
2. `dist/core/index.mjs`에서 `serializeRuntimeHelperSource(...)`와 `createRLM(...)`를 import합니다.
3. helper 본문은 named function으로 작성하고, `serializeRuntimeHelperSource(...)`로 `source` 문자열로 직렬화합니다.
4. 생성한 `RLMPlugin`을 `createRLM({ plugins: [...] })` 또는 `client.run({ plugins: [...] })`에 전달합니다.

`my_plugin.mjs` 예시:

```js
import { serializeRuntimeHelperSource } from './dist/core/index.mjs';

async function toUppercase(input) {
  return String(input).toUpperCase();
}

export function createUppercasePlugin() {
  return {
    name: 'uppercase',
    systemPromptBlocks: [
      '필요하면 `to_uppercase(text)`를 사용해 텍스트를 먼저 정규화하십시오.',
    ],
    runtimeHelpers: [{
      name: 'to_uppercase',
      description: '문자열을 대문자로 변환합니다.',
      inputKinds: ['text'],
      source: serializeRuntimeHelperSource({
        entrypoint: 'toUppercase',
        functions: [toUppercase],
      }),
    }],
  };
}
```

`app.mjs` 예시:

```js
import { createRLM } from './dist/core/index.mjs';
import { createUppercasePlugin } from './my_plugin.mjs';

const client = createRLM({
  llm,
  models: {
    root: 'demo-root',
    sub: 'demo-sub',
  },
  plugins: [createUppercasePlugin()],
});
```

이 방식에서 helper 본문은 최종적으로 worker 안에서 실행되는 순수 JavaScript source로 직렬화됩니다.
즉 plugin authoring 코드는 애플리케이션 모듈에 있어도 되지만, runtime helper 자체는 다음 제약을 그대로
따릅니다.

- helper 본문에는 `import` / `export`를 둘 수 없습니다.
- helper 본문은 브라우저와 Node에서 동일하게 실행될 수 있는 순수 JavaScript여야 합니다.
- helper가 사용하는 바깥 값은 closure로 캡처되지 않으며, 직렬화된 함수 본문 안에 직접 들어 있어야 합니다.
- runtime에서 사용할 수 있는 값은 `input`, `context`, `history`, `llm_query(...)`, `rlm_query(...)`, `grep(...)` 등
  RLM helper scope에 노출된 값뿐입니다.

저장소에 포함된 `plugin/aot`와 `plugin/pingpong`은 같은 방식으로 작성된 reference implementation입니다.

재사용 가능한 플러그인 구현은 `plugin/` 아래에 정리되어 있습니다.

## 예제

현재 저장소의 예제 코드는 `examples/` 아래에 있습니다.

- `examples/standalone/`
  - 문서 질의, query-only 실행, Codex OAuth login/list-models를 포함한 repository-local CLI 예제
- `examples/web/`
  - 브라우저 단일 페이지 앱 예제

플러그인 구현 예제와 재사용 가능한 플러그인은 `plugin/` 아래에 별도로 정리되어 있습니다. 이 예제들은
저장소 사용 예시이며, 패키지 root surface에 그대로 노출되는 public API와는 구분됩니다.

### standalone CLI

standalone CLI는 [examples/standalone](/Users/yoonsung/Development/RLM/examples/standalone) 아래에
있는 저장소 예제용 실행 계층입니다. 입력 파일을 `context.document`로 넣어 RLM 코어를 실행하고,
지정한 시스템 프롬프트 파일로 최종 사용자 응답을 다시 렌더링합니다. 입력 파일이 없으면 빈
`context.document`로 실행할 수 있습니다.

standalone provider는 다음 두 경로를 지원합니다.

- `openai`
- `codex-oauth`

### 실행 모드

#### 1. 문서 질의 실행

```bash
deno task standalone -- \
  --provider openai \
  --aot \
  --input ./book.md \
  --system-prompt ./prompts/rlm_user_answer_system.txt \
  --query "Chapter Three의 핵심 내용은 무엇입니까?"
```

`--aot`는 lite AoT 모드입니다. 단일 decomposition-contraction 경로를 따라가며, 기본적으로
judge/refinement/frontier search를 사용하지 않습니다.

#### 1-0. AoT-hard 실행

```bash
deno task standalone -- \
  --provider openai \
  --aot-hard \
  --aot-debug \
  --input ./book.md \
  --system-prompt ./prompts/rlm_user_answer_system.txt \
  --query "문서에 직접 없는 질문도 충분히 설명해줘"
```

`--aot-hard`는 judge, reflective refinement, frontier search를 포함하는 전체 AoT 탐색입니다.
`--aot-debug`를 함께 쓰면 standalone 진행 로그에 AoT 내부 `llm_query(...)`/`rlm_query(...)`
trace가 `[aot-debug] ...` 형식으로 출력됩니다.

#### 1-1. 입력 파일 없이 질문만 실행

```bash
deno task standalone -- \
  --provider openai \
  --system-prompt ./prompts/rlm_user_answer_system.txt \
  --query "르네상스가 왜 이탈리아에서 먼저 시작되었는지 설명해줘"
```

#### 2. Codex OAuth 로그인

```bash
deno task standalone -- \
  --provider codex-oauth \
  --login
```

로그인 후에는 모델 목록도 바로 출력됩니다.

#### 3. 사용 가능한 모델 목록 조회

```bash
deno task standalone -- \
  --provider codex-oauth \
  --list-models
```

### 주요 옵션

- `--provider <openai|codex-oauth>`: standalone 실행 provider 선택. 기본값은 `openai`
- `--aot`: lite AoT 모드. AoT 플러그인을 붙이고, controller에도 경량 AoT-first 지침을 추가
- `--aot-hard`: hard AoT 모드. judge/refinement/frontier search를 포함하는 전체 AoT 지침을 추가
- `--aot-debug`: AoT 내부 query trace를 standalone 진행 로그에 출력. `--aot` 또는 `--aot-hard`
  와 함께 사용
- `--input <path>`: 분석할 입력 파일 경로. 생략하면 빈 `context.document`로 실행
- `--system-prompt <path>`: 최종 사용자 응답 렌더링용 시스템 프롬프트 파일 경로
- `--query <text>`: 사용자 질문
- `--log <path>`: JSONL 로그 경로 override
- `--request-timeout-ms <ms>`: provider 내부 LLM 요청 timeout override
- `--cell-timeout-ms <ms>`: provider 요청 timeout에 더할 추가 REPL 셀 여유 시간
- `--root-model <model>`: standalone root model override
- `--sub-model <model>`: standalone sub model override
- `--login`: Codex OAuth 로그인 수행 후 저장된 인증 상태를 갱신
- `--list-models`: 현재 provider에서 사용 가능한 모델 목록 출력

### standalone 환경 변수

standalone의 `.env`는 repository-local 설정 파일입니다. 라이브러리 API와 provider API는 `.env`를
자동으로 읽지 않으며, standalone layer만 `.env`를 사용합니다.

`.env.example` 형식:

```dotenv
OPENAI_API_KEY=
RLM_OPENAI_ROOT_MODEL=
RLM_OPENAI_SUB_MODEL=

# Optional overrides
# RLM_OPENAI_BASE_URL=https://api.openai.com/v1
# RLM_OPENAI_ROOT_REASONING_EFFORT=high
# RLM_OPENAI_SUB_REASONING_EFFORT=minimal
# RLM_REQUEST_TIMEOUT_MS=30000
# RLM_CELL_TIMEOUT_MS=5000
# RLM_MAX_STEPS=12
# RLM_MAX_SUBCALL_DEPTH=3
# RLM_MAX_OUTPUT_CHARS=4000
```

현재 `.env` 사용 방식은 다음과 같습니다.

- OpenAI standalone 경로:
  - OpenAI credential, model, runtime limit를 `.env`에서 읽습니다
- Codex OAuth standalone 경로:
  - OAuth 토큰은 `.rlm/codex-oauth.json`에 저장합니다
  - `.env`에서는 request timeout과 runtime limit만 읽습니다

### timeout 의미

- `RLM_REQUEST_TIMEOUT_MS` 또는 `--request-timeout-ms`:
  - provider 내부 HTTP 요청 timeout
- `RLM_CELL_TIMEOUT_MS` 또는 `--cell-timeout-ms`:
  - provider timeout 위에 더해지는 추가 REPL 셀 여유 시간

즉 provider-backed convenience path에서는 총 cell timeout이
`provider request timeout + 추가 셀 여유 시간`으로 계산됩니다.

### 비용 추정

standalone은 provider가 pricing helper를 제공하면 usage line에 비용을 함께 출력합니다.

- OpenAI:
  - `estimateOpenAIRunCostUsd(...)`를 사용해 USD 비용을 계산합니다
- 그 외 provider:
  - pricing helper가 없으면 비용 칸은 빈 값으로 남습니다

### 플러그인 디렉토리

플러그인 구현은 [plugin](/Users/yoonsung/Development/RLM/plugin) 아래에 있습니다.

- `plugin/pingpong/`
  - `"PING"` 입력에 `"PONG"`을 반환하는 최소 runtime helper 플러그인
- `plugin/aot/`
  - AoT(Atom of Thoughts) helper를 작은 functional 조각들로 나누어 구현한 플러그인

### 브라우저 예제

저장소에는 `examples/web/` 디렉터리에 브라우저 단일 페이지 앱 예제가 포함되어 있습니다.

이 예제는 다음 구성을 가집니다.

- React 기반 프론트엔드
- 브라우저에서 직접 실행되는 OpenAI / Ollama provider
- IndexedDB 기반 설정 및 대화 저장
- 모든 이전 대화를 `context`로 재주입하는 브라우저 대화 흐름

## 테스트

기본 테스트:

```bash
deno task test
```

커버리지:

```bash
deno task coverage
```

browser-safe bundle 빌드:

```bash
deno task build:core
```

Node/browser 환경 검증은 `smoke/compose.yml` 기반 컨테이너로 실행됩니다.

- Node smoke 컨테이너: [smoke/node/Dockerfile](/Users/yoonsung/Development/RLM/smoke/node/Dockerfile)
- Browser smoke 컨테이너: [smoke/browser/Dockerfile](/Users/yoonsung/Development/RLM/smoke/browser/Dockerfile)
- 두 smoke 모두 먼저 `dist/` 번들을 만든 뒤, 공개 entrypoint가 실제 런타임에서 import 가능한지 확인합니다.
- smoke는 core/provider bundle뿐 아니라 repository plugin bundle도 함께 확인합니다.
- plugin smoke에서는 `ping_pong("PING")` helper 실행과 `createAoTPlugin()` import surface를 같이 검증합니다.

Node smoke:

```bash
deno task smoke:node
```

Browser smoke:

```bash
deno task smoke:browser
```

smoke task는 `deno.json`에 정의되어 있으며, bundle을 만든 뒤 다음 entrypoint가 실제 Node와 browser
환경에서 import 가능한지 확인합니다.

- `dist/core/index.mjs`
- `dist/providers/openai/index.mjs`
- `dist/providers/ollama/index.mjs`
- `dist/plugin/aot/index.mjs`
- `dist/plugin/pingpong/index.mjs`

동일한 검증은 직접 Docker Compose로도 실행할 수 있습니다.

```bash
docker compose -f smoke/compose.yml build node-smoke browser-smoke
docker compose -f smoke/compose.yml run --rm node-smoke
docker compose -f smoke/compose.yml run --rm browser-smoke
```

배포 전 검증용 묶음은 다음 순서로 사용할 수 있습니다.

```bash
deno task smoke:build
deno task smoke:node
deno task smoke:browser
```

실제 provider 통합 테스트와 long-context benchmark는 별도 task로 분리되어 있습니다.

```bash
deno task test:openai:integration
deno task test:openai:synthetic
deno task test:openai:long-context
deno task test:openai:long-context:evaluator
```
