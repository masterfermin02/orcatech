import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GLOBAL_DIR, type RoleConfig, type Role } from './config.ts';
import type { Plan, Review, TestReport } from './prompts.ts';
import type { ProofStatus, TaskProof } from './redgreen.ts';

export type { ProofStatus, TaskProof };

export const RUNS_DIR = join(GLOBAL_DIR, 'runs');

export type RunStatus =
  | 'planning'
  | 'awaiting_approval'
  | 'coding'
  | 'testing'
  | 'reviewing'
  | 'done'
  | 'failed'
  | 'rejected'
  | 'cancelled';

export type TaskStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface StepRecord {
  id: number;
  role: Role;
  account: string;
  title: string;
  status: 'running' | 'ok' | 'error';
  startedAt: string;
  endedAt?: string;
  costUsd?: number;
  tokens?: { input: number; output: number };
  summary?: string;
  error?: string;
}

export interface TaskRecord {
  status: TaskStatus;
  attempts: number;
  account: string;
  commit?: string;
  /** Resultado de la prueba red→green de la tarea (ausente en corridas antiguas). */
  proof?: TaskProof;
}

export interface RunState {
  id: string;
  idea: string;
  repo: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  projectType: string;
  roles: Record<Role, RoleConfig>;
  branch?: string;
  baseRef?: string;
  plan?: Plan;
  tasks: Record<string, TaskRecord>;
  steps: StepRecord[];
  costUsd: number;
  tokens: { input: number; output: number };
  testReport?: TestReport;
  review?: Review;
  error?: string;
}

export interface RunEvent {
  runId: string;
  ts: string;
  kind: 'status' | 'step' | 'agent' | 'log' | 'error';
  text: string;
  role?: Role;
  account?: string;
}

/** Bus global: el dashboard se suscribe aquí para el streaming SSE. */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function newRunId(): string {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:T]/g, '').slice(2, 12);
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export function runDir(id: string): string {
  return join(RUNS_DIR, id);
}

export function saveRun(state: RunState): void {
  state.updatedAt = new Date().toISOString();
  const dir = runDir(state.id);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, 'state.json.tmp');
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, join(dir, 'state.json'));
  bus.emit('state', state);
}

export function loadRun(id: string): RunState | undefined {
  if (!/^[\w-]+$/.test(id)) return undefined;
  const p = join(runDir(id), 'state.json');
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function listRuns(): RunState[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .map((id) => {
      try {
        return loadRun(id);
      } catch {
        return undefined;
      }
    })
    .filter((r): r is RunState => !!r)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function emit(e: Omit<RunEvent, 'ts'>): void {
  const ev: RunEvent = { ...e, ts: new Date().toISOString() };
  const dir = runDir(e.runId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(ev) + '\n');
  bus.emit('event', ev);
}

export function readEvents(id: string, limit = 500): RunEvent[] {
  if (!/^[\w-]+$/.test(id)) return [];
  const p = join(runDir(id), 'events.jsonl');
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => JSON.parse(l));
}

export function writeArtifact(id: string, name: string, content: string): string {
  const p = join(runDir(id), name);
  mkdirSync(runDir(id), { recursive: true });
  writeFileSync(p, content);
  return p;
}
