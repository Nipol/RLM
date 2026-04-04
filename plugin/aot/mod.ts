/**
 * AoT plugin entrypoint that can be registered on top of the RLM runtime.
 *
 * @module
 *
 * @example
 * ```ts
 * import { createAoTPlugin } from '@yoonsung/rlm/plugin/aot';
 * ```
 */
import type { RLMPlugin } from '../../src/index.ts';
import { AOT_HELPER_SOURCE } from './source.ts';

const AOT_PROMPT_BLOCK = [
  '- `aot(input)`',
  '  - Atom of Thoughts(AoT) 방식으로 현재 질문을 dependency DAG로 분해하고, `solve(Qi)`, `solve(Gi)`, `solve(Qi+1)` 후보를 judge로 비교하여 다음 Markov state를 선택합니다.',
  '  - 필요하면 reflective refinement를 통해 낮은 품질의 contracted state를 다시 다듬습니다.',
  '  - beam search 중에는 선택된 branch마다 누적 frontier score를 유지하며, 이미 `ready`인 후보가 있어도 beam 안의 더 강한 미완료 branch를 계속 탐색할 수 있습니다.',
  '  - 입력값: 비어 있지 않은 텍스트 문자열 또는 `{ question, context?, goal?, maxIterations?, maxIndependentSubquestions?, transitionSamples?, beamWidth?, maxRefinements?, includeTrace? }` 객체',
  '  - `transitionSamples: 1`, `beamWidth: 1`, `maxRefinements: 0` 조합이면 단일 decomposition-contraction 경로를 따라가는 경량 AoT로 실행됩니다.',
  '  - 그 외 설정에서는 judge/refinement/frontier search를 포함하는 전체 AoT 탐색 경로를 사용합니다.',
  '  - 객체 입력은 `question` 또는 `task` 또는 `prompt` 또는 `query` 필드 중 하나에 비어 있지 않은 질문 문자열이 있어야 합니다.',
  '  - 이 helper는 runtime helper이므로, 내부의 `llm_query(...)`, `llm_query_batched(...)` 호출은 현재 REPL cell 안에서 수행되는 보조 계산으로 취급하십시오.',
  '  - `context.document`나 공유 문맥에 직접적인 답이 없더라도 바로 포기하지 말고, 사용자 질의를 더 잘 설명하기 위해 `aot(...)`를 사용하여 질문을 분해하고 풍부한 답변을 구성하십시오.',
  '  - 반환값: `{ answer, finalQuestion, iterations, maxIterations, originalQuestion, stoppedBecause }`',
  '  - `iterations`에는 decomposition, candidate answers, judge selection, refinement 결과와 frontier rank/score가 순서대로 기록됩니다.',
  '  - 트리 가늠:',
  '    같은 depth에서 pruning 전 후보 풀 크기는 대략 `beamWidth × transitionSamples` 입니다. 예를 들어 branch를 `beamWidth`개 유지하고 각 branch마다 contracted state를 `transitionSamples`개 만들면, 다음 depth에 들어가기 전 비교해야 할 후보 수가 그만큼 생깁니다.',
  '    frontier pruning 이후 실제로 다음 depth로 넘어가는 branch 수는 최대 `beamWidth`개입니다.',
  '  - 호출 비용 가늠:',
  '    depth 하나에서 frontier node 하나당 대략 `llm_query` 계열 호출은 `3 + maxIndependentSubquestions + 3×transitionSamples + 3×maxRefinements` 수준까지 늘어날 수 있습니다.',
  '    depth 전체 비용은 여기에 `beamWidth`를 곱한 값에 가깝고, accepted candidate가 beam을 넘는 depth에서는 frontier ranking용 `llm_query`가 최대 1회 더 붙습니다.',
  '    전체 실행 비용은 위 depth 비용이 `maxIterations`회까지 반복될 수 있다고 보고 결정하십시오.',
  '  - 옵션 기준:',
  '    `maxIterations`: depth 수를 직접 늘립니다. 1 늘릴 때마다 위 depth 비용이 한 번 더 반복될 수 있습니다.',
  '    `maxIndependentSubquestions`: decomposition에서 병렬 원자 질문을 몇 개까지 풀지 정합니다. 이 값을 늘리면 depth마다 `llm_query` 비용이 거의 선형으로 증가합니다.',
  '    `transitionSamples`: branch 하나가 만드는 contracted candidate 수입니다. 트리 폭은 사실상 이 값과 `beamWidth`의 곱으로 커집니다.',
  '    `beamWidth`: 다음 depth까지 유지할 branch 수입니다. 이 값을 늘리면 이후 모든 depth의 비용이 거의 선형으로 함께 증가합니다.',
  '    `maxRefinements`: rejected candidate를 다시 다듬는 횟수입니다. refinement는 `llm_query` 기반 재평가 비용을 추가로 붙일 수 있습니다.',
  '    경량 단일 경로를 유지하려면 `transitionSamples: 1`, `beamWidth: 1`, `maxRefinements: 0`를 함께 사용하십시오.',
  '    `includeTrace`: 디버깅이 목적이면 `true`, 비용/출력 크기를 줄이고 최종 답만 원하면 `false`를 사용하십시오.',
  '  - 현재 안전 상한: `maxIterations<=4`, `maxIndependentSubquestions<=4`, `transitionSamples<=3`, `beamWidth<=2`, `maxRefinements<=2`',
  '  - 예시: `const result = await aot("질문");`',
  '  - 예시: `const result = await aot({ question: "질문", maxIterations: {maxIterations}, maxIndependentSubquestions: {maxIndependentSubquestions}, maxRefinements: {maxRefinements}, includeTrace: {includeTrace} });`',
  '  - 예시: `const result = await aot({ question: "질문", context: {...}, maxIterations: {maxIterations}, maxIndependentSubquestions: {maxIndependentSubquestions}, transitionSamples: {transitionSamples}, beamWidth: {beamWidth}, maxRefinements: {maxRefinements}, includeTrace: {includeTrace} });`',
].join('\n');

/**
 * Builds the AoT runtime-helper plugin that can be added to one RLM client.
 */
export function createAoTPlugin(): RLMPlugin {
  return {
    name: 'aot',
    runtimeHelpers: [{
      description:
        'AoT(Atom of Thoughts) 방식으로 질문을 DAG로 분해하고, judge, reflective refinement, beam frontier scoring을 통해 다음 Markov state를 선택합니다.',
      examples: [
        'const result = await aot("질문")',
        'const result = await aot({ question: "질문", maxIterations: {maxIterations}, maxIndependentSubquestions: {maxIndependentSubquestions}, maxRefinements: {maxRefinements}, includeTrace: {includeTrace} })',
        'const result = await aot({ question: "질문", context: {...}, maxIterations: {maxIterations}, maxIndependentSubquestions: {maxIndependentSubquestions}, transitionSamples: {transitionSamples}, beamWidth: {beamWidth}, maxRefinements: {maxRefinements}, includeTrace: {includeTrace} })',
      ],
      inputKinds: ['text', 'object'],
      name: 'aot',
      promptBlock: AOT_PROMPT_BLOCK,
      rlmQueryMaxSubcallDepth: 1,
      returns:
        '`{ answer, finalQuestion, iterations, maxIterations, originalQuestion, stoppedBecause }` 객체',
      signature: 'aot(input)',
      source: AOT_HELPER_SOURCE,
      timeoutMs: 900_000,
    }],
  };
}

export { AOT_HELPER_SOURCE } from './source.ts';
