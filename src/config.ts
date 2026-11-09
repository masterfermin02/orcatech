import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AccountConfig } from './backends/types.ts';

export const ROLES = ['planner', 'coder', 'tester', 'fixer', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

export interface RoleConfig {
  /** Nombre de una cuenta definida en `accounts`. */
  account: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Tope de gasto por llamada (solo Claude reporta USD). */
  maxBudgetUsd?: number;
}

export interface OrcaConfig {
  accounts: Record<string, AccountConfig>;
  roles: Record<Role, RoleConfig>;
  /**
   * Enrutamiento por tipo de tarea: si el plan marca una tarea con `kind`,
   * se usa esta cuenta para programarla (p. ej. { "frontend": "claude-work", "backend": "codex" }).
   */
  routing: Record<string, string>;
  maxFixAttempts: number;
  /** Tope total en USD para una corrida (se cuenta lo que reporta Claude). */
  maxRunBudgetUsd: number;
  /** Crear una rama git `orcatech/<id>` y hacer commit por tarea. */
  git: boolean;
  /** Comando de tests; si falta, se detecta según el proyecto. */
  testCommand?: string;
  /**
   * Prueba red→green por tarea: los tests que agregó o cambió la tarea se corren
   * contra el commit previo (en un worktree temporal) y deben fallar ahí.
   */
  redGreen: boolean;
  /** Revisar el diff de cada tarea con el reviewer y mandar los hallazgos high al fixer. */
  reviewEachTask: boolean;
  /**
   * Escalera de fixers: specs 'cuenta[:modelo]'. El intento N usa
   * fixerLadder[min(N-1, len-1)]. Si falta, se usa siempre `roles.fixer`.
   */
  fixerLadder?: string[];
  port: number;
}

export const DEFAULT_CONFIG: OrcaConfig = {
  accounts: {
    'claude-personal': {
      backend: 'claude',
      unsetEnv: ['CLAUDE_CONFIG_DIR', 'CLAUDE_ACCOUNT'],
      description: 'Claude con la cuenta personal (~/.claude)',
    },
    'claude-work': {
      backend: 'claude',
      env: { CLAUDE_CONFIG_DIR: '~/.claude-work' },
      description: 'Claude con la cuenta de trabajo (~/.claude-work)',
    },
    codex: { backend: 'codex', description: 'OpenAI Codex CLI (~/.codex)' },
    gemini: { backend: 'gemini', description: 'Google Gemini CLI (requiere npm i -g @google/gemini-cli)' },
  },
  roles: {
    planner: { account: 'claude-personal', model: 'claude-opus-5-5', effort: 'high', maxBudgetUsd: 3 },
    coder: { account: 'claude-personal', model: 'claude-opus-5-5', effort: 'high', maxBudgetUsd: 5 },
    tester: { account: 'codex' },
    fixer: { account: 'claude-personal', model: 'claude-opus-5-5', effort: 'high', maxBudgetUsd: 3 },
    reviewer: { account: 'codex' },
  },
  routing: {},
  maxFixAttempts: 3,
  maxRunBudgetUsd: 25,
  git: true,
  redGreen: true,
  reviewEachTask: true,
  port: 4317,
};

export const GLOBAL_DIR = join(homedir(), '.orcatech');
export const GLOBAL_CONFIG = join(GLOBAL_DIR, 'config.json');
export const PROJECT_CONFIG = 'orcatech.config.json';

function readJson(path: string): Partial<OrcaConfig> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`No se pudo leer ${path}: ${(e as Error).message}`);
  }
}

function merge(base: OrcaConfig, over: Partial<OrcaConfig>): OrcaConfig {
  // Escalares y arrays del override reemplazan al valor base; una clave ausente
  // (o explícitamente undefined) no borra el valor heredado.
  const defined = Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined)) as Partial<OrcaConfig>;
  return {
    ...base,
    ...defined,
    accounts: { ...base.accounts, ...over.accounts },
    roles: Object.fromEntries(ROLES.map((r) => [r, { ...base.roles[r], ...over.roles?.[r] }])) as OrcaConfig['roles'],
    routing: { ...base.routing, ...over.routing },
  };
}

/** Defaults ← ~/.orcatech/config.json ← <repo>/orcatech.config.json ← overrides de la corrida. */
export function loadConfig(repo: string, overrides: Partial<OrcaConfig> = {}): OrcaConfig {
  const cfg = merge(merge(merge(DEFAULT_CONFIG, readJson(GLOBAL_CONFIG)), readJson(join(repo, PROJECT_CONFIG))), overrides);
  validate(cfg);
  return cfg;
}

export function validate(cfg: OrcaConfig): void {
  for (const role of ROLES) {
    const acct = cfg.roles[role]?.account;
    if (!acct || !cfg.accounts[acct]) {
      throw new Error(`El rol "${role}" usa la cuenta "${acct}", que no existe. Cuentas: ${Object.keys(cfg.accounts).join(', ')}`);
    }
  }
  for (const [kind, acct] of Object.entries(cfg.routing)) {
    if (!cfg.accounts[acct]) throw new Error(`routing.${kind} apunta a la cuenta inexistente "${acct}"`);
  }
  if (cfg.fixerLadder !== undefined && !Array.isArray(cfg.fixerLadder)) {
    throw new Error('fixerLadder debe ser una lista de specs "cuenta[:modelo]"');
  }
  (cfg.fixerLadder ?? []).forEach((spec, i) => {
    const acct = String(spec).split(':')[0];
    if (!cfg.accounts[acct]) throw new Error(`fixerLadder[${i}] apunta a la cuenta inexistente "${acct}"`);
  });
}

/**
 * Spec de la escalera de fixers para el intento `attempt` (empieza en 1):
 * ladder[min(attempt-1, len-1)]. Con attempt < 1 se usa el índice 0.
 * Devuelve undefined si no hay escalera o está vacía.
 */
export function ladderSpec(ladder: string[] | undefined, attempt: number): string | undefined {
  if (!ladder?.length) return undefined;
  const i = Math.min(Math.max(Math.floor(attempt) - 1, 0), ladder.length - 1);
  return ladder[i];
}

/**
 * Overrides de rol desde la CLI o el dashboard.
 * "codex" cambia solo la cuenta; "claude-work:claude-sonnet-5-5" cambia cuenta y modelo.
 */
export function roleOverride(base: RoleConfig, spec: string, accounts: OrcaConfig['accounts']): RoleConfig {
  const [account, model] = spec.split(':');
  const sameBackend = accounts[account]?.backend === accounts[base.account]?.backend;
  return {
    ...base,
    account,
    // Si cambia de backend, el modelo anterior (p. ej. de Claude) no aplica.
    model: model ?? (sameBackend ? base.model : undefined),
    maxBudgetUsd: base.maxBudgetUsd,
  };
}
