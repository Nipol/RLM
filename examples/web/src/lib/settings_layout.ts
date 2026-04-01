import type { ProviderSettings } from './types.ts';

export interface SettingsPresentation {
  showInlineSetupAside: boolean;
  showSettingsModal: boolean;
  showSecondaryContext: boolean;
}

export function resolveSettingsPresentation(
  settings: ProviderSettings | null,
  isSettingsOpen: boolean,
): SettingsPresentation {
  return {
    showInlineSetupAside: settings === null,
    showSettingsModal: settings !== null && isSettingsOpen,
    showSecondaryContext: false,
  };
}
