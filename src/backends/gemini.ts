import { runProcess } from './proc.ts';
import { accountEnv, extractJson, type AccountConfig, type Backend, type RunRequest, type RunResult } from './types.ts';

/**
 * Gemini vía `gemini -p ... --output-format json` (Gemini CLI).
 * Experimental: la CLI no estaba instalada al escribir esto (npm i -g @google/gemini-cli).
 */
export const geminiBackend: Backend = {
  kind: 'gemini',
  async run(account: AccountConfig, req: RunRequest): Promise<RunResult> {
    let prompt = `${req.instructions}\n\n---\n\n${req.prompt}`;
    if (req.schema) {
      prompt += `\n\nResponde SOLO con un objeto JSON que cumpla este JSON Schema:\n${JSON.stringify(req.schema)}`;
    }
    const args = ['-p', prompt, '--output-format', 'json'];
    // En modo no interactivo, sin --yolo las herramientas que modifican se rechazan (lectura).
    if (req.access === 'write') args.push('--yolo');
    if (req.model) args.push('-m', req.model);

    req.onEvent?.({ kind: 'info', text: 'gemini en ejecución…' });
    const res = await runProcess('gemini', args, { cwd: req.cwd, env: accountEnv(account), signal: req.signal });
    if (res.code === 127) {
      return { ok: false, text: '', error: 'Gemini CLI no está instalada. Instálala con: npm i -g @google/gemini-cli' };
    }

    let text = res.stdout;
    let tokens: RunResult['tokens'];
    try {
      const parsed = JSON.parse(res.stdout);
      text = parsed.response ?? text;
      const models = parsed.stats?.models ?? {};
      let input = 0;
      let output = 0;
      for (const m of Object.values<any>(models)) {
        input += m.tokens?.prompt ?? 0;
        output += m.tokens?.candidates ?? 0;
      }
      tokens = { input, output };
    } catch {
      /* salida no JSON: se usa tal cual */
    }
    if (text) req.onEvent?.({ kind: 'text', text: text.slice(0, 2000) });
    const structured = req.schema ? extractJson(text) : undefined;
    const ok = res.code === 0 && (!req.schema || structured !== undefined);
    return { ok, text, structured, tokens, error: ok ? undefined : res.stderr.trim().slice(-2000) || `gemini salió con código ${res.code}` };
  },
};
