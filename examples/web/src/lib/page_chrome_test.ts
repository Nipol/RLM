import assert from 'node:assert/strict';

import { createProviderSettings } from './provider_config.ts';
import { resolveConversationPageChrome } from './page_chrome.ts';

const settings = createProviderSettings({
  apiKey: 'sk-test',
  availableModels: ['gpt-5', 'gpt-5-mini'],
  baseUrl: 'https://api.openai.com/v1',
  kind: 'openai',
  rootModel: 'gpt-5',
  rootReasoningEffort: 'high',
  subModel: 'gpt-5-mini',
  subReasoningEffort: 'minimal',
}, new Date('2026-04-01T00:00:00.000Z'));

Deno.test('resolveConversationPageChrome uses a task-led page title before provider setup', () => {
  assert.deepEqual(resolveConversationPageChrome(null), {
    actionLabel: 'provider 설정으로 이동',
    breadcrumb: 'Route / agent conversation',
    pageSummary: '브라우저에서 provider를 연결하고 첫 transcript를 시작하는 단계입니다.',
    pageTitle: 'Start a browser RLM conversation',
    taskHeadline: '먼저 provider와 root/sub 모델을 저장하세요.',
    taskSupport:
      '설정 패널에서 provider를 고르고 모델 목록을 불러온 뒤 root/sub 모델을 저장하면 바로 대화를 시작할 수 있습니다.',
  });
});

Deno.test('resolveConversationPageChrome keeps the page header task-led after provider setup', () => {
  assert.deepEqual(resolveConversationPageChrome(settings), {
    actionLabel: '설정 변경',
    breadcrumb: 'Route / agent conversation',
    pageSummary: '브라우저 세션 안에서 RLM과 대화하고 저장된 transcript를 다음 실행의 context로 이어갑니다.',
    pageTitle: 'Continue the browser RLM conversation',
    taskHeadline: '이제 질문을 보내면 저장된 transcript 전체가 context로 함께 전달됩니다.',
    taskSupport:
      '현재 세션의 모든 turn은 IndexedDB에 남고, 새 프롬프트가 들어올 때마다 이전 turn 전체가 RLM 실행 입력으로 다시 전달됩니다.',
  });
});
