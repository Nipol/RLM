import type { AppSnapshot, ChatTurn } from './types.ts';

export interface PreparedPromptRerun {
  historyBeforePrompt: ChatTurn[];
  prompt: string;
  promptTurn: ChatTurn;
  truncatedSnapshot: AppSnapshot;
}

export function prepareLastUserPromptRerun(
  snapshot: AppSnapshot,
): PreparedPromptRerun | null {
  if (snapshot.settings === null) {
    return null;
  }

  const promptIndex = [...snapshot.turns].reverse().findIndex((turn) => turn.role === 'user');
  if (promptIndex < 0) {
    return null;
  }

  const lastUserTurnIndex = snapshot.turns.length - 1 - promptIndex;
  const promptTurn = snapshot.turns[lastUserTurnIndex];
  if (promptTurn === undefined) {
    return null;
  }

  const historyBeforePrompt = snapshot.turns.slice(0, lastUserTurnIndex);
  return {
    historyBeforePrompt,
    prompt: promptTurn.content,
    promptTurn,
    truncatedSnapshot: {
      settings: snapshot.settings,
      turns: [...historyBeforePrompt, promptTurn],
    },
  };
}
