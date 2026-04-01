import assert from 'node:assert/strict';

import { createProviderSettings } from './provider_config.ts';
import { resolveSettingsPresentation } from './settings_layout.ts';

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

Deno.test('resolveSettingsPresentation keeps setup aside visible before any provider settings exist', () => {
  assert.deepEqual(resolveSettingsPresentation(null, false), {
    showInlineSetupAside: true,
    showSettingsModal: false,
    showSecondaryContext: false,
  });
});

Deno.test('resolveSettingsPresentation hides secondary panels after provider settings are saved', () => {
  assert.deepEqual(resolveSettingsPresentation(settings, false), {
    showInlineSetupAside: false,
    showSettingsModal: false,
    showSecondaryContext: false,
  });
});

Deno.test('resolveSettingsPresentation reopens provider editing as a modal after provider settings are saved', () => {
  assert.deepEqual(resolveSettingsPresentation(settings, true), {
    showInlineSetupAside: false,
    showSettingsModal: true,
    showSecondaryContext: false,
  });
});
