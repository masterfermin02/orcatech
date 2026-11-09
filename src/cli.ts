import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { expandHome } from './backends/types.ts';
import { DEFAULT_CONFIG, GLOBAL_CONFIG, GLOBAL_DIR, loadConfig, PROJECT_CONFIG, ROLES, type Role } from './config.ts';
import { detectProject } from './detect.ts';
import { decide, startRun } from './pipeline.ts';
import { resolveRoleSpecs, startServer } from './server.ts';
import { bus, listRuns, loadRun, runDir, type RunEvent, type RunState } from './store.ts';

const HELP = `orcatech — orquestador autónomo de agentes (Claude · Codex · Gemini)

Uso:
  orcatech run "<idea>" [opciones]   Planifica → (apruebas) → programa → testea → revisa
  orcatech dashboard                 Abre solo el dashboard web (crear/aprobar/seguir corridas)
  orcatech accounts                  Muestra cuentas, roles y si cada CLI está disponible
  orcatech init [--global]           Crea orcatech.config.json (o ~/.orcatech/config.json)
  orcatech runs                      Lista corridas
  orcatech show <id>                 Muestra el reporte de una corrida

Opciones de run:
  --repo <dir>          Repo destino (por defecto: carpeta actual)
  --planner <cuenta>    Cuenta para el rol, opcional ":modelo". Ej: --coder codex
  --coder <cuenta>          --reviewer claude-work:claude-sonnet-5-5
  --tester <cuenta>
  --fixer <cuenta>
  --reviewer <cuenta>
  --all <cuenta>        Usa la misma cuenta para todos los roles
  -y, --yes             Aprueba el plan sin preguntar (totalmente autónomo)
  --no-dashboard        No levantar el dashboard
  --port <n>            Puerto del dashboard (por defecto 4317)

Cuentas por defecto: claude-personal, claude-work, codex, gemini (configurables en ${PROJECT_CONFIG}).`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' },
    planner: { type: 'string' },
    coder: { type: 'string' },
    tester: { type: 'string' },
    fixer: { type: 'string' },
    reviewer: { type: 'string' },
    all: { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
    'no-dashboard': { type: 'boolean' },
    port: { type: 'string' },
    global: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [cmd, ...rest] = positionals;
const repo = resolve(values.repo ?? process.cwd());

const C = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m', reset: '\x1b[0m' };

function printEvent(e: RunEvent) {
  const who = e.role ? `${C.cyan}${e.role}${C.dim}@${e.account}${C.reset} ` : '';
  const color = e.kind === 'error' ? C.red : e.kind === 'status' ? C.bold + C.yellow : e.kind === 'step' ? C.green : e.text.startsWith('🔧') ? C.dim : '';
  const text = e.kind === 'agent' && e.text.length > 400 ? e.text.slice(0, 400) + '…' : e.text;
  console.log(`${C.dim}${e.ts.slice(11, 19)}${C.reset} ${who}${color}${text}${C.reset}`);
}

function printPlan(s: RunState) {
  const p = s.plan!;
  console.log(`\n${C.bold}Plan:${C.reset} ${p.summary}`);
  console.log(`${C.dim}Tests: ${p.testCommand || '(se crearán)'}${C.reset}`);
  for (const t of p.tasks) {
    console.log(`  ${C.bold}[${t.id}]${C.reset} ${t.title} ${C.dim}(${t.kind} → ${s.tasks[t.id]?.account})${C.reset}`);
    for (const a of t.acceptance) console.log(`      ${C.dim}✓ ${a}${C.reset}`);
  }
  if (p.risks.length) console.log(`${C.yellow}Riesgos:${C.reset}\n${p.risks.map((r) => `  - ${r}`).join('\n')}`);
}

async function cmdRun() {
  const idea = rest.join(' ').trim();
  if (!idea) throw new Error('Falta la idea. Ej: orcatech run "agregar modo espectador al juego"');
  const specs: Partial<Record<Role, string>> = {};
  for (const r of ROLES) {
    const v = (values as Record<string, unknown>)[r] ?? values.all;
    if (typeof v === 'string') specs[r] = v;
  }
  const roles = resolveRoleSpecs(repo, specs);
  const cfg = loadConfig(repo, { roles: roles as any });
  const port = Number(values.port ?? cfg.port);

  if (!values['no-dashboard']) {
    startServer(port, repo).on('error', (e) => console.log(`${C.yellow}Dashboard no disponible (${(e as Error).message}); sigo en la terminal.${C.reset}`));
    console.log(`${C.dim}Dashboard: http://127.0.0.1:${port}${C.reset}`);
  }
  console.log(`${C.bold}orcatech${C.reset} · ${repo} · ${detectProject(repo).type}`);
  console.log(ROLES.map((r) => `${C.cyan}${r}${C.reset}=${cfg.roles[r].account}${cfg.roles[r].model ? `:${cfg.roles[r].model}` : ''}`).join('  '));

  const { id, done } = startRun({ idea, repo, roles, autoApprove: values.yes });
  console.log(`${C.dim}Corrida ${id} → ${runDir(id)}${C.reset}\n`);
  bus.on('event', (e: RunEvent) => e.runId === id && printEvent(e));

  let rl: ReturnType<typeof createInterface> | undefined;
  bus.on('state', (s: RunState) => {
    if (s.id !== id) return;
    if (s.status === 'awaiting_approval' && !rl) {
      printPlan(s);
      rl = createInterface({ input: process.stdin, output: process.stdout });
      const ask = () =>
        rl!.question(`\n¿Aprobar el plan? ${C.bold}[s]${C.reset}í / [n]o  (o edítalo y apruébalo en el dashboard): `, (a) => {
          const ans = a.trim().toLowerCase();
          if (ans === 's' || ans === 'si' || ans === 'sí' || ans === 'y') decide(id, true);
          else if (ans === 'n' || ans === 'no') decide(id, false);
          else ask();
        });
      ask();
    } else if (s.status !== 'awaiting_approval' && rl) {
      rl.close();
      rl = undefined;
    }
  });

  const final = await done;
  console.log(`\n${C.bold}Estado final: ${final.status}${C.reset} · US$${final.costUsd.toFixed(2)} (Claude) · reporte: ${join(runDir(id), 'report.md')}`);
  if (final.branch) console.log(`Rama: ${final.branch}  →  git diff ${final.baseRef?.slice(0, 8)}...${final.branch}`);
  if (values['no-dashboard']) process.exit(final.status === 'done' ? 0 : 1);
  console.log(`${C.dim}El dashboard sigue abierto; Ctrl+C para salir.${C.reset}`);
}

function which(bin: string) {
  return spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).stdout.trim();
}

function cmdAccounts() {
  const cfg = loadConfig(repo);
  console.log(`${C.bold}Cuentas${C.reset}`);
  for (const [name, a] of Object.entries(cfg.accounts)) {
    let check = '';
    if (a.backend === 'claude') {
      const dir = a.env?.CLAUDE_CONFIG_DIR ? expandHome(a.env.CLAUDE_CONFIG_DIR) : join(process.env.HOME ?? '', '.claude');
      check = existsSync(dir) ? `${C.green}✓ ${dir}${C.reset}` : `${C.red}✗ no existe ${dir}${C.reset}`;
    } else {
      const bin = which(a.backend);
      check = bin ? `${C.green}✓ ${bin}${C.reset}` : `${C.red}✗ falta la CLI "${a.backend}"${a.backend === 'gemini' ? ' (npm i -g @google/gemini-cli)' : ''}${C.reset}`;
    }
    console.log(`  ${C.cyan}${name.padEnd(18)}${C.reset} ${a.backend.padEnd(7)} ${check}  ${C.dim}${a.description ?? ''}${C.reset}`);
  }
  console.log(`\n${C.bold}Roles${C.reset}`);
  for (const r of ROLES) console.log(`  ${r.padEnd(9)} → ${cfg.roles[r].account}${cfg.roles[r].model ? ` (${cfg.roles[r].model})` : ''}`);
  if (Object.keys(cfg.routing).length) {
    console.log(`\n${C.bold}Routing por tipo de tarea${C.reset}`);
    for (const [k, v] of Object.entries(cfg.routing)) console.log(`  ${k.padEnd(12)} → ${v}`);
  }
}

function cmdInit() {
  const target = values.global ? GLOBAL_CONFIG : join(repo, PROJECT_CONFIG);
  if (existsSync(target)) throw new Error(`Ya existe ${target}`);
  if (values.global) mkdirSync(GLOBAL_DIR, { recursive: true });
  const example = {
    $comment: 'Elige qué cuenta hace cada rol. Cuenta = backend (claude|codex|gemini) + entorno (CLAUDE_CONFIG_DIR, CODEX_HOME...).',
    accounts: DEFAULT_CONFIG.accounts,
    roles: DEFAULT_CONFIG.roles,
    routing: { 'game-render': 'claude-personal', backend: 'codex' },
    maxFixAttempts: DEFAULT_CONFIG.maxFixAttempts,
    maxRunBudgetUsd: DEFAULT_CONFIG.maxRunBudgetUsd,
    git: true,
    redGreen: DEFAULT_CONFIG.redGreen,
    reviewEachTask: DEFAULT_CONFIG.reviewEachTask,
    $commentFixerLadder:
      'Opcional: "fixerLadder": ["codex", "claude-personal:claude-opus-5-5"]. El intento N del fixer usa ladder[min(N-1, len-1)].',
  };
  writeFileSync(target, JSON.stringify(example, null, 2) + '\n');
  console.log(`Creado ${target}`);
}

function cmdRuns() {
  for (const r of listRuns()) console.log(`${r.id}  ${r.status.padEnd(18)} US$${r.costUsd.toFixed(2).padStart(6)}  ${r.repo}  ${C.dim}${r.idea.slice(0, 60)}${C.reset}`);
}

function cmdShow() {
  const id = rest[0];
  const r = id && loadRun(id);
  if (!r) throw new Error('Corrida no encontrada');
  const p = join(runDir(id), 'report.md');
  console.log(existsSync(p) ? readFileSync(p, 'utf8') : JSON.stringify(r, null, 2));
}

async function main() {
  if (values.help || !cmd) return console.log(HELP);
  switch (cmd) {
    case 'run':
      return cmdRun();
    case 'dashboard': {
      const port = Number(values.port ?? loadConfig(repo).port);
      startServer(port, repo);
      return console.log(`Dashboard: http://127.0.0.1:${port}  (repo por defecto: ${repo})`);
    }
    case 'accounts':
      return cmdAccounts();
    case 'init':
      return cmdInit();
    case 'runs':
      return cmdRuns();
    case 'show':
      return cmdShow();
    default:
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`${C.red}Error: ${e instanceof Error ? e.message : e}${C.reset}`);
  process.exit(1);
});
