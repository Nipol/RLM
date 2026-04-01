import assert from 'node:assert/strict';
import { DEFAULT_RLM_SYSTEM_PROMPT_MARKDOWN } from '../prompts/rlm_system.ts';

import {
  __rlmPromptTestables,
  buildRLMSystemPrompt,
  buildRLMTurnInput,
  loadDefaultRLMSystemPromptMarkdown,
} from '../src/rlm_prompt.ts';

Deno.test('system prompts load from embedded markdown source and render injected templates', async () => {
  const markdown = await loadDefaultRLMSystemPromptMarkdown();
  const rootPrompt = await buildRLMSystemPrompt({ maxSteps: 7 });
  const childPrompt = await buildRLMSystemPrompt({ role: 'child' });
  const injectedPrompt = await buildRLMSystemPrompt({
    markdown: '# 사용자 정의 시스템\n{{MAX_STEPS_SENTENCE}}\n동적 프롬프트입니다.',
    maxSteps: 3,
  });

  assert.match(rootPrompt, /^# Recursive Language Agent/mu);
  assert.match(rootPrompt, /REPL 환경은 다음과 같이 초기화되어 있습니다\./u);
  assert.match(rootPrompt, /\*\*문제 분해:\*\*/u);
  assert.match(rootPrompt, /프로그래밍 가능한 전략/u);
  assert.doesNotMatch(rootPrompt, /\{\{MAX_STEPS_SENTENCE\}\}/u);
  assert.match(markdown, /^# Recursive Language Agent/mu);
  assert.equal(markdown, DEFAULT_RLM_SYSTEM_PROMPT_MARKDOWN);

  assert.equal(childPrompt, await buildRLMSystemPrompt());
  assert.doesNotMatch(childPrompt, /# Root Controller/u);
  assert.doesNotMatch(childPrompt, /# Focused Child Controller/u);
  assert.match(injectedPrompt, /^# 사용자 정의 시스템/mu);
  assert.match(injectedPrompt, /사용할 수 있는 최대 단계 예산은 3입니다\./u);
  assert.match(injectedPrompt, /동적 프롬프트입니다\./u);
});

Deno.test('surfaced execution feedback renders as plain-text transcript sections', () => {
  const record = __rlmPromptTestables.buildExecutionFeedbackText(
    2,
    1,
    {
      code: '({ pivot: "Project Selene" })',
      finalAnswer: null,
      resultPreview: '{"pivot":"Project Selene"}',
      resultSignals: [{
        kind: 'string',
        path: '$.pivot',
        preview: 'Project Selene',
      }],
      status: 'success',
      stderr: '',
      stdout: 'Project Selene',
    },
    240,
  );

  assert.match(record, /^현재 단계: 2/mu);
  assert.match(record, /^실행: 1/mu);
  assert.match(record, /^상태: success/mu);
  assert.match(record, /REPL 표준 출력:/u);
  assert.match(record, /Project Selene/u);
});

Deno.test('root turn input reflects the current compact prompt shape', () => {
  const input = buildRLMTurnInput({
    context: {
      document: 'Project Selene moved into dossier Silver Fern.',
      question: 'Which dossier now contains the moon garden initiative?',
    },
    currentStep: 2,
    outputCharLimit: 240,
    prompt: 'Find the dossier for the moon garden initiative.',
    totalSteps: 6,
    transcript: [{
      assistantText: '```repl\n({ pivot: "Project Selene" })\n```',
      evaluatorFeedback: 'Use the pivot for a dependent lookup.',
      executions: [{
        code: '({ pivot: "Project Selene" })',
        finalAnswer: null,
        resultPreview: '{"pivot":"Project Selene"}',
        resultSignals: [{
          kind: 'string',
          path: '$.pivot',
          preview: 'Project Selene',
        }],
        status: 'success',
        stderr: '',
        stdout: 'Project Selene',
      }],
      step: 1,
    }],
  });

  assert.match(input, /## REPL 목표 :\nFind the dossier for the moon garden initiative\./u);
  assert.match(input, /질문형 문맥 필드:\n- question: Which dossier now contains the moon garden initiative\?/u);
  assert.match(input, /단계 예산: 2 \/ 6/u);
  assert.doesNotMatch(input, /## REPL 기록 형식/u);
  assert.doesNotMatch(input, /## 최신 REPL 실행/u);
  assert.doesNotMatch(input, /## 이전 REPL 기록/u);
  assert.doesNotMatch(input, /다음 행동:/u);
  assert.doesNotMatch(input, /surfaceType/u);
});

Deno.test('delegated turn input keeps recursive note and plain feedback format', () => {
  const input = buildRLMTurnInput({
    context: {
      expect: 'string',
      payload: { alias: 'moon garden', canonical: 'Project Selene' },
      task: 'Resolve the dossier name for the canonical project.',
    },
    outputCharLimit: 240,
    prompt: 'Unused parent prompt.',
    role: 'child',
    transcript: [{
      assistantText: '```repl\n({ alias: "moon garden" })\n```',
      executions: [{
        code: '({ alias: "moon garden" })',
        finalAnswer: null,
        resultPreview: '{"alias":"moon garden"}',
        resultSignals: [{
          kind: 'string',
          path: '$.alias',
          preview: 'moon garden',
        }],
        status: 'success',
        stderr: '',
        stdout: '',
      }],
      step: 1,
    }],
  });

  assert.match(input, /REPL 목표 :\nResolve the dossier name for the canonical project\./u);
  assert.match(input, /context\.payload :/u);
  assert.match(input, /moon garden/u);
  assert.match(input, /context\.expect :/u);
  assert.match(input, /```text\nstring\n```/u);
  assert.match(input, /## 위임된 증거 안내/u);
  assert.match(input, /좁힌 row를 고르거나 넘길 때 그 원본 필드 이름을 유지/u);
  assert.doesNotMatch(input, /## REPL 기록 형식/u);
  assert.doesNotMatch(input, /다음 행동:/u);
  assert.match(input, /단계 예산: undefined \/ undefined/u);
});

Deno.test('turn input no longer injects large-context or recovery banners', () => {
  const input = buildRLMTurnInput({
    context: { document: 'token '.repeat(25_000) },
    currentStep: 1,
    outputCharLimit: 160,
    prompt: 'Find the identifier.',
    totalSteps: 4,
    transcript: [{
      assistantText: '```repl\nFINAL_VAR("")\n```',
      executions: [{
        code: 'FINAL_VAR("")',
        finalAnswer: '',
        resultPreview: '""',
        status: 'success',
        stderr: '',
        stdout: '',
      }],
      step: 1,
    }],
  });

  assert.doesNotMatch(input, /대형 문맥 모드가 활성화되었습니다\./u);
  assert.doesNotMatch(input, /최종화 복구/u);
  assert.doesNotMatch(input, /실행 복구/u);
});

Deno.test('root turn input keeps the current compact shape even after a failed finalization attempt', () => {
  const input = buildRLMTurnInput({
    context: { document: 'Program Orion entry: status=approved amount=120 reviewer=west.' },
    currentStep: 2,
    outputCharLimit: 160,
    prompt: 'Extract the approved amount.',
    totalSteps: 3,
    transcript: [{
      assistantText: '```repl\nFINAL_VAR(undefined)\n```',
      executions: [{
        code: 'FINAL_VAR(undefined)',
        finalAnswer: 'undefined',
        resultPreview: 'undefined',
        status: 'success',
        stderr: 'Error: boom',
        stdout: 'sample row: amount=120',
      }],
      step: 1,
    }],
  });

  assert.match(input, /단계 예산: 2 \/ 3/u);
  assert.match(input, /## REPL 목표 :\nExtract the approved amount\./u);
  assert.doesNotMatch(input, /## 최신 REPL 실행/u);
  assert.doesNotMatch(input, /채택된 최종 답: undefined/u);
  assert.doesNotMatch(input, /Error: boom/u);
  assert.doesNotMatch(input, /sample row: amount=120/u);
});
