/** Contrato común para cualquier agente (Claude, Codex, Gemini...). */

export type BackendKind = 'claude' | 'codex' | 'gemini';

/** Una cuenta = un backend + credenciales/entorno propios (p. ej. claude-personal, claude-work). */
export interface AccountConfig {
  backend: BackendKind;
  /** Variables de entorno extra; aquí va CLAUDE_CONFIG_DIR, CODEX_HOME, GEMINI_API_KEY, etc. */
  env?: Record<string, string>;
  /** Variables a quitar del entorno heredado (p. ej. CLAUDE_CONFIG_DIR para la cuenta personal). */
  unsetEnv?: string[];
  description?: string;
}

export type Access = 'read' | 'write';

export interface RunRequest {
  role: string;
  prompt: string;
  /** Instrucciones de sistema del rol. */
  instructions: string;
  cwd: string;
  access: Access;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** JSON Schema estricto: si se da, el agente debe devolver JSON con esta forma. */
  schema?: Record<string, unknown>;
  maxTurns?: number;
  maxBudgetUsd?: number;
  signal?: AbortSignal;
  /** Progreso en vivo (texto del agente, herramientas usadas). */
  onEvent?: (e: AgentEvent) => void;
}

export interface AgentEvent {
  kind: 'text' | 'tool' | 'info' | 'error';
  text: string;
}

export interface RunResult {
  ok: boolean;
  text: string;
  structured?: unknown;
  costUsd?: number;
  tokens?: { input: number; output: number };
  error?: string;
}

export interface Backend {
  readonly kind: BackendKind;
  run(account: AccountConfig, req: RunRequest): Promise<RunResult>;
}

/** Construye el entorno del proceso hijo para una cuenta. */
export function accountEnv(account: AccountConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  // Evita que un Claude Code anidado crea que corre dentro de otra sesión.
  delete env.CLAUDECODE;
  for (const k of account.unsetEnv ?? []) delete env[k];
  for (const [k, v] of Object.entries(account.env ?? {})) env[k] = expandHome(v);
  return env;
}

export function expandHome(p: string): string {
  return p.startsWith('~/') || p === '~' ? (process.env.HOME ?? '') + p.slice(1) : p;
}

/** Extrae el primer objeto JSON de un texto (por si el agente lo envuelve en ```json). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {
      /* siguiente candidato */
    }
  }
  return undefined;
}
