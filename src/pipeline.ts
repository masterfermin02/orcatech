import { backends, type RunResult } from './backends/index.ts';
import { ladderSpec, loadConfig, roleOverride, type OrcaConfig, type Role, type RoleConfig } from './config.ts';
import { detectProject, type ProjectInfo } from './detect.ts';
import { commitAll, diffSince, headCommit, isDirty, isGitRepo, startBranch } from './git.ts';
import { runProcess } from './backends/proc.ts';
import { runRedCheck, type RedCheckOptions, type TaskProof } from './redgreen.ts';
import {
  INSTRUCTIONS,
  PLAN_SCHEMA,
  REVIEW_SCHEMA,
  TEST_SCHEMA,
  fixPrompt,
  planPrompt,
  reviewPrompt,
  strengthenTestsPrompt,
  taskPrompt,
  testerPrompt,
  type Plan,
  type PlanTask,
  type Review,
  type TestReport,
} from './prompts.ts';
import { emit, loadRun, newRunId, saveRun, writeArtifact, type RunState, type RunStatus, type TaskRecord } from './store.ts';

export interface StartOptions {
  idea: string;
  repo: string;
  /** Overrides por corrida: { coder: "codex", reviewer: "claude-work:claude-sonnet-5-5" } ya resueltos. */
  roles?: Partial<Record<Role, RoleConfig>>;
  /** Aprueba el plan automáticamente (totalmente autónomo). */
  autoApprove?: boolean;
}

interface Active {
  state: RunState;
  cfg: OrcaConfig;
  info: ProjectInfo;
  abort: AbortController;
  approval?: { resolve: (plan: Plan | null) => void };
}

const active = new Map<string, Active>();

export function isActive(id: string) {
  return active.has(id);
}

/** Inicia una corrida en segundo plano y devuelve su id de inmediato. */
export function startRun(opts: StartOptions): { id: string; done: Promise<RunState> } {
  const cfg = loadConfig(opts.repo, { roles: opts.roles as OrcaConfig['roles'] });
  const info = detectProject(opts.repo);
  const now = new Date().toISOString();
  const state: RunState = {
    id: newRunId(),
    idea: opts.idea,
    repo: opts.repo,
    status: 'planning',
    createdAt: now,
    updatedAt: now,
    projectType: info.type,
    roles: cfg.roles,
    tasks: {},
    steps: [],
    costUsd: 0,
    tokens: { input: 0, output: 0 },
  };
  saveRun(state);
  const ctx: Active = { state, cfg, info, abort: new AbortController() };
  active.set(state.id, ctx);
  const done = execute(ctx, !!opts.autoApprove).finally(() => active.delete(state.id));
  return { id: state.id, done };
}

/** Aprueba (opcionalmente con el plan editado) o rechaza el plan de una corrida en espera. */
export function decide(id: string, approve: boolean, editedPlan?: Plan): boolean {
  const ctx = active.get(id);
  if (!ctx?.approval) return false;
  ctx.approval.resolve(approve ? editedPlan ?? ctx.state.plan! : null);
  ctx.approval = undefined;
  return true;
}

export function cancel(id: string): boolean {
  const ctx = active.get(id);
  if (!ctx) return false;
  ctx.abort.abort();
  ctx.approval?.resolve(null);
  return true;
}

// ───────────────────────────── ejecución ─────────────────────────────

function setStatus(ctx: Active, status: RunStatus, text?: string) {
  ctx.state.status = status;
  saveRun(ctx.state);
  emit({ runId: ctx.state.id, kind: 'status', text: text ?? status });
}

function overBudget(ctx: Active) {
  return ctx.state.costUsd >= ctx.cfg.maxRunBudgetUsd;
}

/** Ejecuta un rol con su cuenta/backend y registra el paso. */
async function callAgent(
  ctx: Active,
  role: Role,
  title: string,
  prompt: string,
  extra: { schema?: Record<string, unknown>; account?: string; spec?: string } = {},
): Promise<RunResult> {
  if (ctx.abort.signal.aborted) throw new Error('cancelado');
  if (overBudget(ctx)) throw new Error(`Se alcanzó el tope de gasto de la corrida (US$${ctx.cfg.maxRunBudgetUsd})`);

  const base = ctx.state.roles[role];
  const roleCfg: RoleConfig = extra.spec
    ? roleOverride(base, extra.spec, ctx.cfg.accounts)
    : extra.account
      ? { ...base, account: extra.account, model: sameBackend(ctx, extra.account, base.account) ? base.model : undefined }
      : base;
  const account = ctx.cfg.accounts[roleCfg.account];
  const backend = backends[account.backend];
  const access = role === 'planner' || role === 'reviewer' ? 'read' : 'write';
  const remaining = ctx.cfg.maxRunBudgetUsd - ctx.state.costUsd;

  const step = {
    id: ctx.state.steps.length + 1,
    role,
    account: roleCfg.account,
    title,
    status: 'running' as const,
    startedAt: new Date().toISOString(),
  };
  ctx.state.steps.push(step);
  saveRun(ctx.state);
  emit({ runId: ctx.state.id, kind: 'step', role, account: roleCfg.account, text: `▶ ${title} — ${roleCfg.account}${roleCfg.model ? ` (${roleCfg.model})` : ''}` });

  const res = await backend.run(account, {
    role,
    prompt,
    instructions: INSTRUCTIONS[role],
    cwd: ctx.state.repo,
    access,
    model: roleCfg.model,
    effort: roleCfg.effort,
    schema: extra.schema,
    maxBudgetUsd: Math.max(0.5, Math.min(roleCfg.maxBudgetUsd ?? remaining, remaining)),
    signal: ctx.abort.signal,
    onEvent: (e) => emit({ runId: ctx.state.id, kind: e.kind === 'error' ? 'error' : 'agent', role, account: roleCfg.account, text: e.kind === 'tool' ? `🔧 ${e.text}` : e.text }),
  });

  const rec = ctx.state.steps[step.id - 1];
  Object.assign(rec, {
    status: res.ok ? 'ok' : 'error',
    endedAt: new Date().toISOString(),
    costUsd: res.costUsd,
    tokens: res.tokens,
    summary: res.text.slice(0, 1500),
    error: res.error,
  });
  ctx.state.costUsd += res.costUsd ?? 0;
  ctx.state.tokens.input += res.tokens?.input ?? 0;
  ctx.state.tokens.output += res.tokens?.output ?? 0;
  saveRun(ctx.state);
  emit({
    runId: ctx.state.id,
    kind: res.ok ? 'step' : 'error',
    role,
    account: roleCfg.account,
    text: res.ok ? `✓ ${title}${res.costUsd ? ` · US$${res.costUsd.toFixed(2)}` : ''}` : `✗ ${title}: ${res.error ?? 'falló'}`,
  });
  return res;
}

/**
 * Rol efectivo del fixer para el intento `attempt` (empieza en 1).
 * Sin fixerLadder devuelve roles.fixer tal cual; con escalera aplica
 * ladder[min(attempt-1, len-1)] sobre roles.fixer.
 */
export function resolveFixerRole(
  cfg: Pick<OrcaConfig, 'fixerLadder' | 'accounts'>,
  roles: Record<Role, RoleConfig>,
  attempt: number,
): RoleConfig {
  const spec = ladderSpec(cfg.fixerLadder, attempt);
  return spec ? roleOverride(roles.fixer, spec, cfg.accounts) : roles.fixer;
}

/** Spec 'cuenta[:modelo]' del escalón del fixer para este intento, o undefined sin escalera. */
function fixerSpec(ctx: Active, attempt: number): string | undefined {
  return ladderSpec(ctx.cfg.fixerLadder, attempt);
}

/** Sufijo del título del paso con el escalón usado, p. ej. " (codex)". */
function rungLabel(spec: string | undefined): string {
  return spec ? ` (${spec})` : '';
}

function sameBackend(ctx: Active, a: string, b: string) {
  return ctx.cfg.accounts[a]?.backend === ctx.cfg.accounts[b]?.backend;
}

async function runTests(ctx: Active, command: string): Promise<{ ok: boolean; output: string }> {
  emit({ runId: ctx.state.id, kind: 'log', text: `$ ${command}` });
  const r = await runProcess('/bin/sh', ['-c', command], {
    cwd: ctx.state.repo,
    env: { ...process.env, CI: '1' },
    signal: ctx.abort.signal,
    timeoutMs: 15 * 60_000,
  });
  const output = `${r.stdout}\n${r.stderr}`.trim();
  const tail = output.slice(-6000);
  emit({ runId: ctx.state.id, kind: r.code === 0 ? 'log' : 'error', text: r.code === 0 ? '✓ tests pasan' : `✗ tests fallan (código ${r.code})\n${tail.slice(-1500)}` });
  return { ok: r.code === 0, output: tail };
}

// ───────────────────────── prueba red→green ─────────────────────────

export interface ProofInput {
  taskId: string;
  /** Registro de la tarea ya testeada y con su commit (se muta: proof, attempts, status, commit). */
  record: TaskRecord;
  /** Prompt de la tarea (contexto para el reparador). */
  context: string;
  repo: string;
  testCommand?: string;
  preCommit?: string;
  redGreen: boolean;
  git: boolean;
  maxFixAttempts: number;
  signal?: AbortSignal;
}

export interface ProofDeps {
  redCheck: (opts: RedCheckOptions) => Promise<TaskProof>;
  head: (repo: string) => Promise<string>;
  /** Llama al reparador (intento `attempt`) con el prompt de refuerzo. */
  fix: (attempt: number, prompt: string) => Promise<unknown>;
  runTests: () => Promise<{ ok: boolean; output: string }>;
  commit: (message: string) => Promise<string | undefined>;
  status: (text: string) => void;
  log: (text: string) => void;
  save: () => void;
}

/** Motivo para no correr la prueba, o undefined si corresponde correrla. */
export function proofSkip(input: Pick<ProofInput, 'record' | 'testCommand' | 'preCommit' | 'redGreen' | 'git'>): TaskProof | undefined {
  const skipped = (detail: string): TaskProof => ({ status: 'skipped', detail, testFiles: [] });
  if (!input.redGreen) return skipped('Prueba red→green desactivada (redGreen: false).');
  if (!input.git) return skipped('Sin git: no hay commit previo con el cual comparar.');
  if (!input.testCommand) return skipped('El plan no tiene comando de tests.');
  if (input.record.status !== 'passed') return skipped('La tarea no pasó sus tests.');
  if (!input.preCommit) return skipped('No se registró el commit previo a la tarea.');
  if (!input.record.commit) return { status: 'no-tests', detail: 'La tarea no generó cambios (sin commit).', testFiles: [] };
  return undefined;
}

export function proofLogText(taskId: string, proof: TaskProof): string {
  const icon = proof.status === 'proven' ? '✓' : proof.status === 'not-red' ? '⚠' : '➖';
  return `${icon} Prueba red→green de [${taskId}]: ${proof.status} — ${proof.detail}`;
}

/**
 * Prueba red→green de una tarea ya commiteada. Si sale not-red y quedan intentos,
 * el reparador refuerza los tests una vez (cuenta para maxFixAttempts), se re-testea,
 * se hace commit y se repite la prueba con el mismo commit previo.
 * Nunca lanza por fallos de la prueba en sí (quedan 'inconclusive'); sí propaga los
 * errores del reparador (cancelación, tope de gasto), como el resto del pipeline.
 */
export async function proveTask(input: ProofInput, deps: ProofDeps): Promise<TaskProof> {
  const t = input.record;
  const set = (proof: TaskProof) => {
    t.proof = proof;
    deps.save();
    deps.log(proofLogText(input.taskId, proof));
    return proof;
  };

  const skip = proofSkip(input);
  if (skip) {
    t.proof = skip;
    deps.save();
    return skip;
  }

  const check = async (): Promise<TaskProof> => {
    try {
      const post = await deps.head(input.repo);
      return await deps.redCheck({
        repo: input.repo,
        preCommit: input.preCommit!,
        postCommit: post,
        testCommand: input.testCommand!,
        signal: input.signal,
      });
    } catch (e) {
      return { status: 'inconclusive', detail: `La prueba red→green falló: ${e instanceof Error ? e.message : String(e)}`, testFiles: [] };
    }
  };

  deps.status(`Prueba red→green de [${input.taskId}]`);
  const proof = set(await check());
  if (proof.status !== 'not-red') return proof;
  if (t.attempts >= input.maxFixAttempts) {
    deps.log(`Sin intentos de reparación restantes para reforzar los tests de [${input.taskId}]; queda not-red.`);
    return proof;
  }

  t.attempts++;
  await deps.fix(t.attempts, strengthenTestsPrompt(input.context, proof));
  const result = await deps.runTests();
  const commit = await deps.commit(`orcatech: [${input.taskId}] refuerzo de tests${result.ok ? '' : ' (tests fallando)'}`);
  if (commit) t.commit = commit;
  if (!result.ok) {
    t.status = 'failed';
    deps.save();
    deps.log(`✗ Tras reforzar los tests, [${input.taskId}] ya no pasa: queda failed.`);
    return proof;
  }
  deps.save();
  deps.status(`Prueba red→green de [${input.taskId}] (tras refuerzo)`);
  return set(await check());
}

/** Cuenta para programar una tarea: elección manual > routing por tipo > rol coder. */
function accountForTask(ctx: Active, task: PlanTask): string {
  return task.account ?? ctx.cfg.routing[task.kind] ?? ctx.state.roles.coder.account;
}

async function execute(ctx: Active, autoApprove: boolean): Promise<RunState> {
  const s = ctx.state;
  try {
    // 0. Preparación git (antes de que nadie toque archivos).
    const git = ctx.cfg.git && (await isGitRepo(s.repo));
    if (ctx.cfg.git && !git) emit({ runId: s.id, kind: 'log', text: '⚠ El destino no es un repo git: se trabajará sin rama ni commits. (Recomendado: git init)' });
    if (git && (await isDirty(s.repo))) throw new Error('El repo tiene cambios sin commit. Haz commit o stash antes de correr orcatech.');

    // 1. Plan.
    setStatus(ctx, 'planning', `Planificando (${s.projectType})…`);
    const planRes = await callAgent(ctx, 'planner', 'Plan', planPrompt(s.idea, ctx.info), { schema: PLAN_SCHEMA });
    if (!planRes.ok || !planRes.structured) throw new Error(`El planificador no devolvió un plan válido: ${planRes.error ?? planRes.text.slice(0, 500)}`);
    let plan = planRes.structured as Plan;
    if (!plan.testCommand && (ctx.cfg.testCommand || ctx.info.testCommand)) plan.testCommand = ctx.cfg.testCommand ?? ctx.info.testCommand!;
    s.plan = plan;
    for (const t of plan.tasks) s.tasks[t.id] = { status: 'pending', attempts: 0, account: accountForTask(ctx, t) };
    writeArtifact(s.id, 'plan.json', JSON.stringify(plan, null, 2));

    // 2. Aprobación (única pausa).
    if (!autoApprove) {
      setStatus(ctx, 'awaiting_approval', 'Plan listo: esperando tu aprobación (dashboard o terminal)');
      const decided = await new Promise<Plan | null>((resolve) => (ctx.approval = { resolve }));
      if (!decided) {
        setStatus(ctx, ctx.abort.signal.aborted ? 'cancelled' : 'rejected', 'Plan rechazado');
        return s;
      }
      plan = decided;
      s.plan = plan;
      for (const t of plan.tasks) s.tasks[t.id] = { status: 'pending', attempts: 0, account: accountForTask(ctx, t) };
      writeArtifact(s.id, 'plan.json', JSON.stringify(plan, null, 2));
    }

    if (git) {
      s.branch = `orcatech/${s.id}`;
      s.baseRef = await startBranch(s.repo, s.branch);
      emit({ runId: s.id, kind: 'log', text: `Rama de trabajo: ${s.branch}` });
    }

    // 3. Código + tests + arreglos, tarea por tarea.
    for (const task of plan.tasks) {
      const t = s.tasks[task.id];
      setStatus(ctx, 'coding', `[${task.id}] ${task.title}`);
      t.status = 'running';
      const pre = git ? await headCommit(s.repo) : undefined;
      t.preCommit = pre;
      saveRun(s);
      const context = taskPrompt(plan, task, ctx.info);
      const code = await callAgent(ctx, 'coder', `Programar [${task.id}] ${task.title}`, context, { account: t.account });
      if (!code.ok) emit({ runId: s.id, kind: 'error', text: `El programador reportó un error; se intentará reparar.` });

      let passed = !plan.testCommand;
      if (plan.testCommand) {
        setStatus(ctx, 'testing', `Tests de [${task.id}]`);
        let result = await runTests(ctx, plan.testCommand);
        while (!result.ok && t.attempts < ctx.cfg.maxFixAttempts) {
          t.attempts++;
          const spec = fixerSpec(ctx, t.attempts);
          await callAgent(
            ctx,
            'fixer',
            `Reparar [${task.id}] intento ${t.attempts}/${ctx.cfg.maxFixAttempts}${rungLabel(spec)}`,
            fixPrompt(context, result.output),
            { spec },
          );
          result = await runTests(ctx, plan.testCommand);
        }
        passed = result.ok;
      }
      t.status = passed ? 'passed' : 'failed';
      if (git) t.commit = await commitAll(s.repo, `orcatech: [${task.id}] ${task.title}${passed ? '' : ' (tests fallando)'}`);
      saveRun(s);

      await proveTask(
        {
          taskId: task.id,
          record: t,
          context,
          repo: s.repo,
          testCommand: plan.testCommand,
          preCommit: pre,
          redGreen: ctx.cfg.redGreen,
          git: !!git,
          maxFixAttempts: ctx.cfg.maxFixAttempts,
          signal: ctx.abort.signal,
        },
        {
          redCheck: runRedCheck,
          head: headCommit,
          fix: (attempt, prompt) => {
            const spec = fixerSpec(ctx, attempt);
            return callAgent(ctx, 'fixer', `Reforzar tests de [${task.id}] intento ${attempt}/${ctx.cfg.maxFixAttempts}${rungLabel(spec)}`, prompt, { spec });
          },
          runTests: () => runTests(ctx, plan.testCommand),
          commit: async (message) => (git ? commitAll(s.repo, message) : undefined),
          status: (text) => setStatus(ctx, 'testing', text),
          log: (text) => emit({ runId: s.id, kind: 'log', text }),
          save: () => saveRun(s),
        },
      );
    }

    // 4. Test de aceptación de afuera hacia adentro.
    setStatus(ctx, 'testing', 'Verificación de aceptación');
    const test = await callAgent(ctx, 'tester', 'Tests de aceptación', testerPrompt(plan, ctx.info), { schema: TEST_SCHEMA });
    if (test.structured) s.testReport = test.structured as TestReport;
    if (git) await commitAll(s.repo, 'orcatech: tests de aceptación');

    // 5. Revisión y una ronda de correcciones si hay problemas graves.
    setStatus(ctx, 'reviewing', 'Revisión de código');
    const diff = git && s.baseRef ? await diffSince(s.repo, s.baseRef) : '(sin git: revisa los archivos modificados)';
    const rev = await callAgent(ctx, 'reviewer', 'Revisión', reviewPrompt(plan, diff), { schema: REVIEW_SCHEMA });
    if (rev.structured) s.review = rev.structured as Review;
    const serious = s.review?.issues.filter((i) => i.severity === 'high') ?? [];
    const failingCriteria = s.testReport?.criteria.filter((c) => c.status === 'fail') ?? [];
    if (serious.length || failingCriteria.length) {
      const issues = [
        ...serious.map((i) => `- [revisión] ${i.file}: ${i.description}`),
        ...failingCriteria.map((c) => `- [aceptación] ${c.criterion}: ${c.evidence}`),
      ].join('\n');
      const spec = fixerSpec(ctx, 1);
      await callAgent(
        ctx,
        'fixer',
        `Corregir hallazgos de revisión/aceptación${rungLabel(spec)}`,
        fixPrompt(`Objetivo: ${plan.summary}\n\nHallazgos a corregir:\n${issues}`, s.testReport?.summary ?? ''),
        { spec },
      );
      if (plan.testCommand) await runTests(ctx, plan.testCommand);
      if (git) await commitAll(s.repo, 'orcatech: correcciones de revisión');
    }

    setStatus(ctx, 'done', `Listo. ${s.branch ? `Revisa la rama ${s.branch}` : ''}`);
    writeArtifact(s.id, 'report.md', renderReport(s));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    s.error = msg;
    setStatus(ctx, ctx.abort.signal.aborted ? 'cancelled' : 'failed', msg);
    writeArtifact(s.id, 'report.md', renderReport(s));
  }
  return s;
}

export function renderReport(s: RunState): string {
  const lines = [
    `# orcatech · ${s.id}`,
    '',
    `**Idea:** ${s.idea}`,
    `**Repo:** ${s.repo} · **Tipo:** ${s.projectType} · **Estado:** ${s.status}`,
    s.branch ? `**Rama:** \`${s.branch}\` (base \`${s.baseRef?.slice(0, 8)}\`)` : '',
    `**Costo estimado (Claude):** US$${s.costUsd.toFixed(2)} · **Tokens:** ${s.tokens.input.toLocaleString()} in / ${s.tokens.output.toLocaleString()} out`,
    s.error ? `\n> ⚠ ${s.error}` : '',
    '',
    '## Tareas',
    ...(s.plan?.tasks ?? []).map((t) => `- ${s.tasks[t.id]?.status === 'passed' ? '✅' : s.tasks[t.id]?.status === 'failed' ? '❌' : '⏳'} [${t.id}] ${t.title} — ${s.tasks[t.id]?.account}${s.tasks[t.id]?.commit ? ` (${s.tasks[t.id]?.commit})` : ''}`),
  ];
  if (s.testReport) {
    lines.push('', '## Aceptación', s.testReport.summary, ...s.testReport.criteria.map((c) => `- ${c.status === 'pass' ? '✅' : c.status === 'fail' ? '❌' : '➖'} ${c.criterion}`));
  }
  if (s.review) {
    lines.push('', `## Revisión: ${s.review.verdict}`, s.review.summary, ...s.review.issues.map((i) => `- **${i.severity}** \`${i.file}\`: ${i.description}`));
  }
  lines.push('', '## Pasos', ...s.steps.map((st) => `- ${st.status === 'ok' ? '✓' : st.status === 'error' ? '✗' : '…'} ${st.role} · ${st.account} · ${st.title}${st.costUsd ? ` · US$${st.costUsd.toFixed(2)}` : ''}`));
  return lines.filter((l) => l !== '').join('\n') + '\n';
}

export { loadRun };
