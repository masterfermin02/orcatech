import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from './proc.ts';
import { accountEnv, extractJson, type AccountConfig, type Backend, type RunRequest, type RunResult } from './types.ts';

/** Codex vía `codex exec --json`. Para otra cuenta, usa env.CODEX_HOME en la cuenta. */
export const codexBackend: Backend = {
  kind: 'codex',
  async run(account: AccountConfig, req: RunRequest): Promise<RunResult> {
    const tmp = await mkdtemp(join(tmpdir(), 'orcatech-codex-'));
    const lastFile = join(tmp, 'last.txt');
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', req.cwd, '-o', lastFile];
    args.push('-s', req.access === 'write' ? 'workspace-write' : 'read-only');
    if (req.model) args.push('-m', req.model);
    if (req.effort) args.push('-c', `model_reasoning_effort="${req.effort === 'max' || req.effort === 'xhigh' ? 'high' : req.effort}"`);
    if (req.schema) {
      const schemaFile = join(tmp, 'schema.json');
      await writeFile(schemaFile, JSON.stringify(req.schema));
      args.push('--output-schema', schemaFile);
    }
    args.push(`${req.instructions}\n\n---\n\n${req.prompt}`);

    let input = 0;
    let output = 0;
    let lastError: string | undefined;
    const res = await runProcess('codex', args, {
      cwd: req.cwd,
      env: accountEnv(account),
      signal: req.signal,
      onLine: (line) => {
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.type === 'item.completed' && ev.item) {
          const it = ev.item;
          if (it.type === 'agent_message' && it.text) req.onEvent?.({ kind: 'text', text: it.text });
          else if (it.type === 'command_execution') req.onEvent?.({ kind: 'tool', text: `shell ${String(it.command ?? '').slice(0, 160)}` });
          else if (it.type === 'file_change') req.onEvent?.({ kind: 'tool', text: `edit ${JSON.stringify(it.changes ?? '').slice(0, 160)}` });
        } else if (ev.type === 'turn.completed' && ev.usage) {
          input += ev.usage.input_tokens ?? 0;
          output += ev.usage.output_tokens ?? 0;
        } else if (ev.type === 'error' || ev.type === 'turn.failed') {
          lastError = ev.message ?? ev.error?.message ?? line;
        }
      },
    });

    const text = await readFile(lastFile, 'utf8').catch(() => '');
    await rm(tmp, { recursive: true, force: true });
    const structured = req.schema ? extractJson(text) : undefined;
    const ok = res.code === 0 && (!req.schema || structured !== undefined);
    return {
      ok,
      text,
      structured,
      tokens: { input, output },
      error: ok ? undefined : lastError ?? (res.stderr.trim().slice(-2000) || `codex salió con código ${res.code}`),
    };
  },
};
