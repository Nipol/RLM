import {
  Bot,
  BrainCircuit,
  Cloud,
  Database,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  ServerCog,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { startTransition, useEffect, useRef, useState } from 'react';

import { Badge } from './components/ui/badge.tsx';
import { Button } from './components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card.tsx';
import { Dialog } from './components/ui/dialog.tsx';
import { Input } from './components/ui/input.tsx';
import { Label } from './components/ui/label.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select.tsx';
import { Separator } from './components/ui/separator.tsx';
import { ScrollArea } from './components/ui/scroll-area.tsx';
import { Textarea } from './components/ui/textarea.tsx';
import { loadProviderCatalog, runConversationTurn } from './rlm_browser.ts';
import {
  createProviderSettings,
  DEFAULT_REQUEST_TIMEOUT_MS,
  getProviderLabel,
  OPENAI_REASONING_EFFORT_OPTIONS,
  resolveModelSelection,
} from './lib/provider_config.ts';
import { resolveConversationPageChrome } from './lib/page_chrome.ts';
import { prepareLastUserPromptRerun } from './lib/rerun.ts';
import { resolveSettingsPresentation } from './lib/settings_layout.ts';
import { loadAppSnapshot, saveAppSnapshot } from './lib/storage.ts';
import type { AppSnapshot, ChatTurn, ProviderDraft, ProviderKind, ProviderSettings } from './lib/types.ts';
import { cn } from './lib/utils.ts';

const PROVIDER_ORDER: ProviderKind[] = ['openai', 'ollama-local', 'ollama-cloud'];
const EMPTY_SNAPSHOT: AppSnapshot = { settings: null, turns: [] };

const providerCopy: Record<ProviderKind, {
  accent: string;
  description: string;
  helper: string;
  title: string;
}> = {
  'ollama-cloud': {
    accent: 'Cloud browser runtime',
    description: '공식 cloud API를 브라우저에서 직접 호출합니다.',
    helper: 'API 키로 모델 카탈로그를 가져오고, 선택한 root/sub 모델로 RLM을 실행합니다.',
    title: 'Ollama Cloud',
  },
  'ollama-local': {
    accent: 'Local API over HTTP',
    description: '로컬 Ollama 주소를 직접 입력하고 `/api/tags` 연결을 검증합니다.',
    helper: '모델 목록 확인이 끝나면 root/sub 모델을 고른 뒤 바로 브라우저에서 실행합니다.',
    title: 'Ollama Local',
  },
  openai: {
    accent: 'Responses API in browser',
    description: 'OpenAI API 키와 모델 목록을 브라우저 안에서 직접 사용합니다.',
    helper: '설정 저장 뒤에는 모든 대화 turn이 IndexedDB에 보관되고, 다음 질문 때 전체 히스토리가 context로 다시 들어갑니다.',
    title: 'OpenAI',
  },
};

function createEmptyDraft(kind: ProviderKind): ProviderDraft {
  return {
    apiKey: '',
    availableModels: [],
    baseUrl: kind === 'openai'
      ? 'https://api.openai.com/v1'
      : kind === 'ollama-local'
      ? 'http://localhost:11434'
      : 'https://ollama.com/api',
    kind,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    rootModel: '',
    rootReasoningEffort: undefined,
    subModel: '',
    subReasoningEffort: undefined,
  };
}

function draftFromSettings(settings: ProviderSettings): ProviderDraft {
  return {
    apiKey: settings.apiKey,
    availableModels: settings.availableModels,
    baseUrl: settings.baseUrl,
    kind: settings.kind,
    requestTimeoutMs: settings.requestTimeoutMs,
    rootModel: settings.rootModel,
    rootReasoningEffort: settings.rootReasoningEffort,
    subModel: settings.subModel,
    subReasoningEffort: settings.subReasoningEffort,
  };
}

function createTurn(role: ChatTurn['role'], content: string, extra: Partial<ChatTurn> = {}): ChatTurn {
  return {
    content,
    createdAt: new Date().toISOString(),
    id: crypto.randomUUID(),
    role,
    ...extra,
  };
}

function formatTimestamp(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) {
    return '-';
  }

  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

function formatUsage(turn: ChatTurn): string | null {
  if (turn.usage === undefined) {
    return null;
  }

  return `${turn.usage.totalTokens.toLocaleString('ko-KR')} tokens`;
}

function RLMMark({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn('project-mark', className)}>
      <span>RLM</span>
    </div>
  );
}

function ProviderHero({
  activeKind,
  onSelect,
}: {
  activeKind: ProviderKind;
  onSelect: (kind: ProviderKind) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
      {PROVIDER_ORDER.map((kind, index) => {
        const isActive = kind === activeKind;
        const icon = kind === 'openai' ? BrainCircuit : kind === 'ollama-local' ? ServerCog : Cloud;
        const Icon = icon;

        return (
            <button
            className={cn(
              'provider-choice rise-in rounded-[20px] border-[1.5px] px-4 py-4 text-left',
            )}
            data-active={isActive}
            key={kind}
            onClick={() => onSelect(kind)}
            type="button"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <p className="editorial-kicker">0{index + 1} / provider</p>
                <p className="font-serif text-base font-bold leading-[1.65] tracking-0">{providerCopy[kind].title}</p>
                <p className="text-sm leading-6 text-muted-foreground">{providerCopy[kind].description}</p>
              </div>
              <span className="provider-choice-icon">
                <Icon className="size-4" />
              </span>
            </div>
            <Separator className="my-4 opacity-50" />
            <p className="text-xs leading-6 text-[color:var(--ledger)]">
              {isActive ? '현재 draft에 적용된 provider입니다.' : providerCopy[kind].accent}
            </p>
          </button>
        );
      })}
    </div>
  );
}

function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(EMPTY_SNAPSHOT);
  const [draft, setDraft] = useState<ProviderDraft>(createEmptyDraft('openai'));
  const [prompt, setPrompt] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isBooting, setIsBooting] = useState(true);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [showSettings, setShowSettings] = useState(true);
  const endOfTurnsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    void loadAppSnapshot()
      .then((loadedSnapshot) => {
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setSnapshot(loadedSnapshot);
          setDraft(loadedSnapshot.settings === null
            ? createEmptyDraft('openai')
            : draftFromSettings(loadedSnapshot.settings));
          setShowSettings(false);
          setIsBooting(false);
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setErrorMessage(error instanceof Error ? error.message : String(error));
        setIsBooting(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    endOfTurnsRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'end',
    });
  }, [snapshot.turns.length, isRunning]);

  async function persistSnapshot(nextSnapshot: AppSnapshot): Promise<void> {
    startTransition(() => setSnapshot(nextSnapshot));
    await saveAppSnapshot(nextSnapshot);
  }

  function handleProviderSelect(kind: ProviderKind) {
    setErrorMessage('');
    setStatusMessage('');
    setDraft((currentDraft) => {
      if (currentDraft.kind === kind) {
        return currentDraft;
      }

      const nextDraft = createEmptyDraft(kind);
      return {
        ...nextDraft,
        apiKey: kind === 'ollama-local' ? '' : currentDraft.apiKey,
        requestTimeoutMs: currentDraft.requestTimeoutMs,
      };
    });
  }

  function handleOpenSettingsEditor() {
    if (snapshot.settings === null) {
      document.getElementById('provider-setup-panel')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
      return;
    }

    setErrorMessage('');
    setStatusMessage('');
    setDraft(draftFromSettings(snapshot.settings));
    setShowSettings(true);
  }

  function handleCloseSettingsEditor() {
    if (snapshot.settings !== null) {
      setDraft(draftFromSettings(snapshot.settings));
    }

    setShowSettings(false);
  }

  async function handleLoadModels() {
    setErrorMessage('');
    setStatusMessage('');
    setIsFetchingModels(true);

    try {
      const catalog = await loadProviderCatalog(draft);
      const selection = resolveModelSelection(catalog.availableModels, draft.rootModel, draft.subModel);

      setDraft((currentDraft) => ({
        ...currentDraft,
        availableModels: catalog.availableModels,
        baseUrl: catalog.baseUrl,
        rootModel: selection.rootModel,
        subModel: selection.subModel,
      }));
      setStatusMessage(`${getProviderLabel(draft.kind)} 모델 ${catalog.availableModels.length}개를 확인했습니다.`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsFetchingModels(false);
    }
  }

  async function handleSaveSettings() {
    setErrorMessage('');
    setStatusMessage('');
    setIsSavingSettings(true);

    try {
      const settings = createProviderSettings(draft);
      const nextSnapshot: AppSnapshot = {
        settings,
        turns: snapshot.turns,
      };

      await persistSnapshot(nextSnapshot);
      setDraft(draftFromSettings(settings));
      setShowSettings(false);
      setStatusMessage(`${getProviderLabel(settings.kind)} 설정을 저장했습니다.`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function handleClearConversation() {
    const nextSnapshot: AppSnapshot = {
      settings: snapshot.settings,
      turns: [],
    };

    await persistSnapshot(nextSnapshot);
    setStatusMessage('IndexedDB에 저장된 대화를 비웠습니다.');
  }

  async function handleSubmitPrompt() {
    const settings = snapshot.settings;
    const trimmedPrompt = prompt.trim();
    if (settings === null || trimmedPrompt.length === 0 || isRunning) {
      return;
    }

    setErrorMessage('');
    setStatusMessage('');
    setIsRunning(true);
    setPrompt('');

    const historyTurns = snapshot.turns;
    const userTurn = createTurn('user', trimmedPrompt);
    const userSnapshot: AppSnapshot = {
      settings,
      turns: [...historyTurns, userTurn],
    };

    try {
      await persistSnapshot(userSnapshot);
      const result = await runConversationTurn(settings, historyTurns, trimmedPrompt);
      const assistantTurn = createTurn('assistant', result.answer, {
        steps: result.steps,
        usage: result.usage,
      });
      const finalSnapshot: AppSnapshot = {
        settings,
        turns: [...userSnapshot.turns, assistantTurn],
      };

      await persistSnapshot(finalSnapshot);
      setStatusMessage(`응답을 저장했습니다. 총 ${finalSnapshot.turns.length}개 turn이 IndexedDB에 기록되어 있습니다.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedAssistantTurn = createTurn('assistant', `오류: ${message}`, {
        error: message,
      });
      const failedSnapshot: AppSnapshot = {
        settings,
        turns: [...userSnapshot.turns, failedAssistantTurn],
      };

      await persistSnapshot(failedSnapshot);
      setErrorMessage(message);
    } finally {
      setIsRunning(false);
    }
  }

  async function handleRerunLastPrompt() {
    if (isRunning) {
      return;
    }

    const preparedRerun = prepareLastUserPromptRerun(snapshot);
    const settings = preparedRerun?.truncatedSnapshot.settings ?? null;
    if (preparedRerun === null || settings === null) {
      return;
    }

    setErrorMessage('');
    setStatusMessage('');
    setIsRunning(true);

    try {
      await persistSnapshot(preparedRerun.truncatedSnapshot);
      const result = await runConversationTurn(
        settings,
        preparedRerun.historyBeforePrompt,
        preparedRerun.prompt,
      );
      const assistantTurn = createTurn('assistant', result.answer, {
        steps: result.steps,
        usage: result.usage,
      });
      const finalSnapshot: AppSnapshot = {
        settings,
        turns: [...preparedRerun.truncatedSnapshot.turns, assistantTurn],
      };

      await persistSnapshot(finalSnapshot);
      setStatusMessage(
        `마지막 프롬프트를 다시 실행했습니다. 이후 turn을 정리하고 총 ${finalSnapshot.turns.length}개 turn을 저장했습니다.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedAssistantTurn = createTurn('assistant', `오류: ${message}`, {
        error: message,
      });
      const failedSnapshot: AppSnapshot = {
        settings,
        turns: [...preparedRerun.truncatedSnapshot.turns, failedAssistantTurn],
      };

      await persistSnapshot(failedSnapshot);
      setErrorMessage(message);
    } finally {
      setIsRunning(false);
    }
  }

  const activeSettings = snapshot.settings;
  const activeCopy = providerCopy[draft.kind];
  const preparedRerun = prepareLastUserPromptRerun(snapshot);
  const settingsPresentation = resolveSettingsPresentation(activeSettings, showSettings);
  const pageChrome = resolveConversationPageChrome(activeSettings);
  const connectionSummary = activeSettings === null
    ? '저장된 provider가 없습니다.'
    : `${getProviderLabel(activeSettings.kind)}가 이 브라우저에 저장되어 있습니다.`;
  const settingsEditor = (
    <div className="space-y-5">
      <ProviderHero activeKind={draft.kind} onSelect={handleProviderSelect} />

      <div className="space-y-5">
        <div className="grid gap-4">
          {(draft.kind === 'openai' || draft.kind === 'ollama-cloud') && (
            <div className="grid gap-2">
              <Label htmlFor="api-key">API Key</Label>
              <Input
                className="font-mono text-[13px]"
                id="api-key"
                onChange={(event) => setDraft((currentDraft) => ({
                  ...currentDraft,
                  apiKey: event.target.value,
                }))}
                placeholder={draft.kind === 'openai' ? 'sk-...' : 'ollama cloud api key'}
                type="password"
                value={draft.apiKey}
              />
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="base-url">
              {draft.kind === 'openai'
                ? 'Base URL'
                : draft.kind === 'ollama-local'
                ? 'Ollama 주소'
                : 'Cloud Base URL'}
            </Label>
            <Input
              className="font-mono text-[13px]"
              disabled={draft.kind === 'ollama-cloud'}
              id="base-url"
              onChange={(event) => setDraft((currentDraft) => ({
                ...currentDraft,
                baseUrl: event.target.value,
              }))}
              placeholder={draft.kind === 'ollama-local' ? 'http://localhost:11434' : 'https://api.openai.com/v1'}
              value={draft.baseUrl}
            />
          </div>

          {draft.kind === 'openai' && (
            <div className="grid gap-2">
              <Label htmlFor="request-timeout-ms">OpenAI Request Timeout (ms)</Label>
              <Input
                className="font-mono text-[13px]"
                id="request-timeout-ms"
                min={1_000}
                onChange={(event) => {
                  const nextValue = Number.parseInt(event.target.value, 10);
                  setDraft((currentDraft) => ({
                    ...currentDraft,
                    requestTimeoutMs: Number.isFinite(nextValue) ? nextValue : undefined,
                  }));
                }}
                placeholder="30000"
                type="number"
                value={draft.requestTimeoutMs ?? ''}
              />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[22rem] text-xs leading-6 text-muted-foreground">
            {draft.kind === 'ollama-local'
              ? '입력한 주소에 연결한 뒤 `/api/tags` 결과를 기준으로 선택지를 채웁니다.'
              : '브라우저가 직접 원격 모델 카탈로그를 호출합니다.'}
          </p>
          <Button disabled={isFetchingModels} onClick={() => void handleLoadModels()} size="sm" variant="outline">
            {isFetchingModels
              ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  확인 중
                </>
              )
              : (
                <>
                  <RefreshCw className="size-4" />
                  모델 목록 불러오기
                </>
              )}
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-2">
            <Label>Root Model</Label>
            <Select
              onValueChange={(value) => setDraft((currentDraft) => ({ ...currentDraft, rootModel: value }))}
              value={draft.rootModel}
            >
              <SelectTrigger>
                <SelectValue placeholder="root 모델 선택" />
              </SelectTrigger>
              <SelectContent>
                {draft.availableModels.map((modelId) => (
                  <SelectItem key={`root-${modelId}`} value={modelId}>
                    {modelId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Sub Model</Label>
            <Select
              onValueChange={(value) => setDraft((currentDraft) => ({ ...currentDraft, subModel: value }))}
              value={draft.subModel}
            >
              <SelectTrigger>
                <SelectValue placeholder="sub 모델 선택" />
              </SelectTrigger>
              <SelectContent>
                {draft.availableModels.map((modelId) => (
                  <SelectItem key={`sub-${modelId}`} value={modelId}>
                    {modelId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {draft.kind === 'openai' && (
          <div className="grid gap-3">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label>Root Reasoning</Label>
                <Select
                  onValueChange={(value) => setDraft((currentDraft) => ({
                    ...currentDraft,
                    rootReasoningEffort: value === 'automatic' ? undefined : value,
                  }))}
                  value={draft.rootReasoningEffort ?? 'automatic'}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="root reasoning 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="automatic">automatic</SelectItem>
                    {OPENAI_REASONING_EFFORT_OPTIONS.map((effort) => (
                      <SelectItem key={`root-reasoning-${effort}`} value={effort}>
                        {effort}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Sub Reasoning</Label>
                <Select
                  onValueChange={(value) => setDraft((currentDraft) => ({
                    ...currentDraft,
                    subReasoningEffort: value === 'automatic' ? undefined : value,
                  }))}
                  value={draft.subReasoningEffort ?? 'automatic'}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="sub reasoning 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="automatic">automatic</SelectItem>
                    {OPENAI_REASONING_EFFORT_OPTIONS.map((effort) => (
                      <SelectItem key={`sub-reasoning-${effort}`} value={effort}>
                        {effort}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-xs leading-6 text-muted-foreground">
              reasoning 지원 값은 모델마다 다를 수 있습니다. 지원하지 않는 조합이면 OpenAI API가 오류를 반환합니다.
            </p>
            <p className="text-xs leading-6 text-muted-foreground">
              이 제한 시간은 브라우저에서 보내는 `/models`와 `/responses` OpenAI 호출에 그대로 적용됩니다.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[22rem] text-xs leading-6 text-muted-foreground">
            선택한 provider 설정은 IndexedDB에 저장되므로, 다음 접속 시에도 바로 이어서 사용할 수 있습니다.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {activeSettings !== null && (
              <Button onClick={handleCloseSettingsEditor} type="button" variant="borderless">
                취소
              </Button>
            )}
            <Button disabled={isSavingSettings} onClick={() => void handleSaveSettings()}>
              {isSavingSettings
                ? (
                  <>
                    <LoaderCircle className="size-4 animate-spin" />
                    저장 중
                  </>
                )
                : '설정 저장'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <main className="mx-auto min-h-screen w-full max-w-[1480px] px-3 py-3 md:px-6 md:py-6 xl:px-8">
      <Card className="relative overflow-hidden rounded-[32px] border-[1.5px]" data-testid="web-shell">
        <CardContent className="p-4 md:p-8 xl:p-14">
          <div className="sticky top-3 z-20 bg-card pb-6">
            <header className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex items-center gap-4">
                <RLMMark className="h-[58px] w-[58px]" />
                <div className="space-y-1">
                  <p className="editorial-kicker">shared app shell / rlm</p>
                  <p className="font-serif text-base font-bold leading-[1.65] tracking-0">Recursive Language Model</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">examples/web</Badge>
                <Badge variant="outline">browser-native runtime</Badge>
                <Badge variant="outline">indexeddb memory</Badge>
              </div>
            </header>
            <Separator className="mt-6 opacity-60" />
          </div>

          <section className="rise-in space-y-5 pt-2">
            <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
              <div className="max-w-[56rem] space-y-3">
                <p className="editorial-kicker">{pageChrome.breadcrumb}</p>
                <h1 className="page-title">{pageChrome.pageTitle}</h1>
                <p className="max-w-[44rem] text-[16px] leading-[1.65] text-[color:var(--ledger)]">
                  {pageChrome.pageSummary}
                </p>
              </div>
              <div className="flex flex-col items-start gap-3 xl:items-end">
                <Button
                  onClick={handleOpenSettingsEditor}
                  size="sm"
                  variant={activeSettings === null ? 'default' : 'outline'}
                >
                  <KeyRound className="size-4" />
                  {pageChrome.actionLabel}
                </Button>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="brand">
                    {activeSettings === null ? 'setup required' : 'ready to prompt'}
                  </Badge>
                  {activeSettings !== null && <Badge variant="outline">{getProviderLabel(activeSettings.kind)}</Badge>}
                </div>
              </div>
            </div>

            <div className="task-status-panel rounded-[20px] border px-5 py-4 md:px-6">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="editorial-kicker">Task status</p>
                  <p className="font-serif text-base font-bold leading-[1.65] tracking-0">{pageChrome.taskHeadline}</p>
                  <p className="text-sm leading-7 text-muted-foreground">{pageChrome.taskSupport}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs leading-6 text-[color:var(--ledger)]">
                  <span>provider: {activeSettings === null ? '선택 필요' : getProviderLabel(activeSettings.kind)}</span>
                  <span className="text-[color:var(--metadata)]">/</span>
                  <span>root: {activeSettings === null ? 'unconfigured' : activeSettings.rootModel}</span>
                  <span className="text-[color:var(--metadata)]">/</span>
                  <span>turns: {snapshot.turns.length}</span>
                  <span className="text-[color:var(--metadata)]">/</span>
                  <span>runtime: {isBooting ? '로딩 중' : '준비됨'}</span>
                </div>
              </div>
            </div>
          </section>

          <Separator className="my-10 opacity-60" />

          <section
            className={cn(
              'grid gap-10',
              settingsPresentation.showInlineSetupAside && 'xl:grid-cols-[minmax(0,1fr)_332px]',
            )}
          >
            <div className="space-y-8">
              <Card className="overflow-hidden" data-testid="transcript-card">
                <CardHeader className="gap-6 pb-6">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                    <div className="flex items-start gap-4">
                      <RLMMark className="mt-1 h-12 w-12 rounded-[16px]" />
                      <div className="space-y-3">
                        <div className="flex items-center gap-2">
                          <Bot className="size-4 text-foreground" />
                          <span className="editorial-kicker">Primary task / indexed transcript</span>
                        </div>
                        <CardTitle>Agent Transcript</CardTitle>
                        <CardDescription className="max-w-2xl">
                          새 프롬프트가 들어오면 이전 turn 전체가 context로 다시 주입됩니다. rerun을 누르면 마지막
                          사용자 프롬프트 이후 turn은 정리되고 다시 실행됩니다.
                        </CardDescription>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {activeSettings !== null && (
                        <Badge variant="outline">{getProviderLabel(activeSettings.kind)}</Badge>
                      )}
                      <Button
                        disabled={snapshot.turns.length === 0 || isRunning}
                        onClick={() => void handleClearConversation()}
                        size="sm"
                        variant="borderless"
                      >
                        <Trash2 className="size-4" />
                        대화 비우기
                      </Button>
                    </div>
                  </div>
                  <div className="paper-rule" />
                </CardHeader>
                <CardContent className="flex flex-col gap-5">
                  <ScrollArea className="min-h-[520px]">
                    <div className="space-y-4 pr-3">
                      {snapshot.turns.length === 0
                        ? (
                          <div
                            className="rise-in flex min-h-80 flex-col items-start justify-center gap-4 rounded-[20px] border border-dashed border-border bg-card px-6 py-8 text-left"
                            data-testid="empty-transcript"
                          >
                            <RLMMark className="h-12 w-12 rounded-[16px]" />
                            <div className="space-y-2">
                              <p className="font-serif text-[28px] leading-tight tracking-[-0.02em]">
                                아직 저장된 turn이 없습니다
                              </p>
                              <p className="max-w-xl text-sm leading-7 text-muted-foreground">
                                provider를 저장한 뒤 질문을 보내면 사용자 turn과 assistant turn이 모두 IndexedDB에
                                기록되고, 다음 실행의 context에도 같은 순서로 다시 반영됩니다.
                              </p>
                            </div>
                          </div>
                        )
                        : snapshot.turns.map((turn) => (
                          <article
                            className={cn(
                              'rise-in rounded-[24px] border px-5 py-5',
                              turn.role === 'user'
                                ? 'message-user ml-auto max-w-[92%]'
                                : turn.error !== undefined
                                ? 'message-error mr-auto max-w-[95%]'
                                : 'message-assistant mr-auto max-w-[95%]',
                            )}
                            key={turn.id}
                          >
                            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge variant={turn.error !== undefined ? 'danger' : 'outline'}>
                                  {turn.role === 'user' ? 'USER' : turn.error !== undefined ? 'ERROR' : 'RLM'}
                                </Badge>
                                {turn.steps !== undefined && <Badge variant="outline">{turn.steps} steps</Badge>}
                                {formatUsage(turn) !== null && <Badge variant="outline">{formatUsage(turn)}</Badge>}
                              </div>
                              <span className="text-xs text-muted-foreground">{formatTimestamp(turn.createdAt)}</span>
                            </div>
                            <p className="whitespace-pre-wrap text-sm leading-7 text-[color:var(--ledger)]">{turn.content}</p>
                          </article>
                        ))}
                      {isRunning && (
                        <div className="rise-in flex items-center gap-3 rounded-[18px] border border-[color:var(--soft-border)] bg-card px-4 py-3 text-sm text-[color:var(--ledger)]">
                          <LoaderCircle className="size-4 animate-spin text-foreground" />
                          브라우저에서 RLM을 실행하고 있습니다.
                        </div>
                      )}
                      <div ref={endOfTurnsRef} />
                    </div>
                  </ScrollArea>

                  <Separator className="opacity-60" />

                  <div className="space-y-4">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 text-sm text-[color:var(--ledger)]">
                          <Database className="size-4 text-foreground" />
                          turn 저장: IndexedDB
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {activeSettings !== null && (
                          <>
                            <Badge variant="outline">root: {activeSettings.rootModel}</Badge>
                            <Badge variant="outline">sub: {activeSettings.subModel}</Badge>
                          </>
                        )}
                      </div>
                    </div>
                    <Textarea
                      className="font-mono"
                      onChange={(event) => setPrompt(event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                          event.preventDefault();
                          void handleSubmitPrompt();
                        }
                      }}
                      placeholder="질문을 입력하세요. 이전 대화 전체는 자동으로 context에 포함됩니다. Cmd/Ctrl + Enter로 전송할 수 있습니다."
                      value={prompt}
                    />
                    <div className="mt-4 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                      <p className="max-w-2xl text-xs leading-6 text-muted-foreground">
                        {activeSettings === null
                          ? '아직 provider 설정이 없습니다. 설정 패널에서 provider와 모델을 저장하면 전송할 수 있습니다.'
                          : '현재 입력은 새로운 root turn으로 실행되며, 이전 히스토리는 `context` 객체로 주입됩니다.'}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          disabled={preparedRerun === null || isRunning}
                          onClick={() => void handleRerunLastPrompt()}
                          variant="outline"
                        >
                          <RefreshCw className="size-4" />
                          마지막 프롬프트 다시 실행
                        </Button>
                        <Button
                          disabled={activeSettings === null || isRunning || prompt.trim().length === 0}
                          onClick={() => void handleSubmitPrompt()}
                          variant="brand"
                        >
                          {isRunning
                            ? (
                              <>
                                <LoaderCircle className="size-4 animate-spin" />
                                실행 중
                              </>
                            )
                            : (
                              <>
                                <Sparkles className="size-4" />
                                보내기
                              </>
                            )}
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {(statusMessage.length > 0 || errorMessage.length > 0) && (
                <Card className={cn(errorMessage.length > 0 ? 'status-error' : 'status-success')}>
                  <CardContent className="p-5 md:p-6">
                    <p className="editorial-kicker">{errorMessage.length > 0 ? 'System notice / error' : 'System notice / success'}</p>
                    <p className="mt-3 text-sm leading-7 text-[color:var(--ledger)]">
                      {errorMessage.length > 0 ? errorMessage : statusMessage}
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>

            {settingsPresentation.showInlineSetupAside && (
              <aside className="space-y-6">
                <Card className="overflow-hidden" data-testid="provider-card">
                  <CardHeader className="gap-5 pb-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-3">
                        <div className="flex items-center gap-2">
                          <KeyRound className="size-4 text-foreground" />
                          <span className="editorial-kicker">Secondary panel / setup</span>
                        </div>
                        <CardTitle>{activeCopy.title}</CardTitle>
                        <CardDescription>{activeCopy.helper}</CardDescription>
                      </div>
                      <Badge variant="brand">setup required</Badge>
                    </div>
                    <div className="paper-rule" />
                  </CardHeader>
                  <CardContent className="space-y-5">
                    <div className="connection-summary-panel rounded-[20px] border p-4" id="provider-setup-panel">
                      <p className="editorial-kicker">Current connection</p>
                      <p className="mt-2 font-serif text-base font-bold leading-[1.65] tracking-0">{connectionSummary}</p>
                      <p className="mt-2 text-sm leading-7 text-muted-foreground">
                        provider 설정이 끝나면 이 aside는 사라지고, 이후 편집은 modal로만 열립니다.
                      </p>
                    </div>
                    {settingsEditor}
                  </CardContent>
                </Card>
              </aside>
            )}
          </section>

          <div className="mt-10 flex items-center gap-4">
            <div className="paper-rule" />
            <span className="editorial-kicker whitespace-nowrap">RLM web console</span>
          </div>
        </CardContent>
      </Card>

      <Dialog
        description="저장된 provider를 다시 편집할 때만 modal로 열립니다."
        onOpenChange={(open) => {
          if (!open) {
            handleCloseSettingsEditor();
          }
        }}
        open={settingsPresentation.showSettingsModal}
        title={`${activeCopy.title} Settings`}
      >
        {settingsEditor}
      </Dialog>
    </main>
  );
}

export default App;
