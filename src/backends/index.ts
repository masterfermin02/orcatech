import { claudeBackend } from './claude.ts';
import { codexBackend } from './codex.ts';
import { geminiBackend } from './gemini.ts';
import type { Backend, BackendKind } from './types.ts';

export const backends: Record<BackendKind, Backend> = {
  claude: claudeBackend,
  codex: codexBackend,
  gemini: geminiBackend,
};

export * from './types.ts';
