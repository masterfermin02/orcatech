import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { accountEnv, extractJson, type AccountConfig, type Backend, type RunRequest, type RunResult } from './types.ts';

const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
const READ_BASH = ['Bash(ls:*)', 'Bash(cat:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git status:*)', 'Bash(find:*)', 'Bash(wc:*)'];
const WRITE_TOOLS = [...READ_TOOLS, 'Write', 'Edit', 'NotebookEdit', 'Bash', 'TodoWrite'];
// Nunca publica nada por su cuenta: sin push, sin deploy.
const ALWAYS_DENY = ['Bash(git push:*)', 'Bash(git remote:*)', 'Bash(npm publish:*)', 'Bash(fly deploy:*)', 'Bash(rm -rf /:*)'];

export const claudeBackend: Backend = {
  kind: 'claude',
  async run(account: AccountConfig, req: RunRequest): Promise<RunResult> {
    const abortController = new AbortController();
    req.signal?.addEventListener('abort', () => abortController.abort(), { once: true });

    const options: Options = {
      cwd: req.cwd,
      env: accountEnv(account),
      model: req.model,
      effort: req.effort,
      maxTurns: req.maxTurns ?? (req.access === 'write' ? 80 : 30),
      maxBudgetUsd: req.maxBudgetUsd,
      abortController,
      // Carga el CLAUDE.md y .claude/ del proyecto destino.
      settingSources: ['project'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: req.instructions },
      // Sin canUseTool, lo no permitido se deniega en vez de preguntar: el agente nunca se queda colgado.
      permissionMode: req.access === 'write' ? 'acceptEdits' : 'dontAsk',
      allowedTools: req.access === 'write' ? WRITE_TOOLS : [...READ_TOOLS, ...READ_BASH],
      disallowedTools: req.access === 'write' ? ALWAYS_DENY : ['Write', 'Edit', 'NotebookEdit', ...ALWAYS_DENY],
      ...(req.schema ? { outputFormat: { type: 'json_schema' as const, schema: req.schema } } : {}),
    };

    let text = '';
    let structured: unknown;
    let costUsd: number | undefined;
    let tokens: RunResult['tokens'];
    let ok = false;
    let error: string | undefined;

    try {
      for await (const m of query({ prompt: req.prompt, options })) {
        if (m.type === 'assistant') {
          for (const block of m.message.content) {
            if (block.type === 'text' && block.text.trim()) req.onEvent?.({ kind: 'text', text: block.text });
            else if (block.type === 'tool_use') req.onEvent?.({ kind: 'tool', text: describeTool(block.name, block.input) });
          }
        } else if (m.type === 'result') {
          // total_cost_usd es acumulativo: se toma el último, no se suma.
          costUsd = m.total_cost_usd;
          tokens = { input: m.usage.input_tokens, output: m.usage.output_tokens };
          if (m.permission_denials?.length) {
            const names = m.permission_denials.map((d) => d.tool_name).join(', ');
            req.onEvent?.({ kind: 'info', text: `⚠ ${m.permission_denials.length} uso(s) de herramienta denegado(s) por permisos: ${names}` });
          }
          if (m.subtype === 'success') {
            ok = !m.is_error;
            text = m.result;
            structured = m.structured_output;
          } else {
            error = m.subtype;
          }
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    if (req.schema && structured === undefined && text) structured = extractJson(text);
    if (req.schema && structured === undefined) ok = false;
    return { ok, text, structured, costUsd, tokens, error };
  },
};

function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const detail = i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.description ?? '';
  return `${name} ${String(detail).slice(0, 160)}`.trim();
}
