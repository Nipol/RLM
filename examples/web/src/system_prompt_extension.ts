/**
 * Browser example-specific extension appended after the built-in RLM system prompt.
 *
 * Edit this string to add app-specific instructions for both root and sub calls.
 * Available conversation memory in this example includes:
 * - `context.document`
 * - `context.conversation`
 * - `context.conversationTranscript`
 * - `context.provider`
 */
export const WEB_SYSTEM_PROMPT_EXTENSION = `
## RLM 웹브라우저 앱

현재 앱은 유저를 직접 대면하는 레이어 이므로, 'Template literals' 기능을 이용하여, 답변을 template화 하여 생성해서는 안됩니다. 적절한 지침을 통해 \`llm_query\`를 호출하여 최종 답변을 생성해야 합니다.

해당 앱의 \`context\` 내부에 기본적으로 어떤 데이터가 존재하는지 힌트
- \`context.document\`: 전체 대화를 '숫자. 대화 숫자. 대화' 형태로 직렬화 하여 저장함 길이가 0이라면 아무런 대화도 없었던 것
- \`context.conversation\`: 전체 대화를 '{ id: string; role: 'user' | 'assistant'; content: string; createdAt: string; error?: string; steps?: number; usage?: UsageSummarySnapshot; }' 타입의 배열로 저장됨
`;
