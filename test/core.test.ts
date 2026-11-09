import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { accountEnv, extractJson } from '../src/backends/types.ts';
import { DEFAULT_CONFIG, ladderSpec, loadConfig, roleOverride } from '../src/config.ts';
import { detectProject } from '../src/detect.ts';
import { PROOF_LABELS, highIssues, proveTask, proofLogText, renderReport, resolveFixerRole, reviewTask, type ProofDeps, type ProofInput, type TaskReviewDeps, type TaskReviewInput } from '../src/pipeline.ts';
import { PLAN_SCHEMA, REVIEW_SCHEMA, TEST_SCHEMA, fixPrompt, strengthenTestsPrompt, taskReviewPrompt, type Plan, type Review } from '../src/prompts.ts';
import { changedFiles, diffRange, headCommit, showFile } from '../src/git.ts';
import { classifyRedRun, isTestFile, newSourceFiles, pickTestFiles, runRedCheck } from '../src/redgreen.ts';
import type { RunState, TaskProof, TaskRecord } from '../src/store.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'orcatech-test-'));

test('extractJson lee JSON plano y dentro de ```json', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Aquí va:\n```json\n{"b":[1,2]}\n```\nfin'), { b: [1, 2] });
  assert.equal(extractJson('sin json'), undefined);
});

test('la cuenta personal quita CLAUDE_CONFIG_DIR y la de trabajo lo apunta a ~/.claude-work', () => {
  process.env.CLAUDE_CONFIG_DIR = '/algo';
  const personal = accountEnv(DEFAULT_CONFIG.accounts['claude-personal']);
  const work = accountEnv(DEFAULT_CONFIG.accounts['claude-work']);
  assert.equal(personal.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(work.CLAUDE_CONFIG_DIR, `${process.env.HOME}/.claude-work`);
  delete process.env.CLAUDE_CONFIG_DIR;
});

test('roleOverride cambia cuenta y descarta el modelo si cambia de backend', () => {
  const base = DEFAULT_CONFIG.roles.coder;
  assert.deepEqual(roleOverride(base, 'codex', DEFAULT_CONFIG.accounts).model, undefined);
  assert.equal(roleOverride(base, 'claude-work', DEFAULT_CONFIG.accounts).model, base.model);
  assert.equal(roleOverride(base, 'claude-work:claude-sonnet-5-5', DEFAULT_CONFIG.accounts).model, 'claude-sonnet-5-5');
});

test('loadConfig mezcla la config del proyecto y valida cuentas', () => {
  const repo = tmp();
  writeFileSync(join(repo, 'orcatech.config.json'), JSON.stringify({ roles: { coder: { account: 'codex' } }, routing: { frontend: 'claude-work' } }));
  const cfg = loadConfig(repo);
  assert.equal(cfg.roles.coder.account, 'codex');
  assert.equal(cfg.roles.planner.account, DEFAULT_CONFIG.roles.planner.account);
  assert.equal(cfg.routing.frontend, 'claude-work');
  writeFileSync(join(repo, 'orcatech.config.json'), JSON.stringify({ roles: { coder: { account: 'no-existe' } } }));
  assert.throws(() => loadConfig(repo), /no existe/);
});

test('DEFAULT_CONFIG activa redGreen y reviewEachTask, sin fixerLadder', () => {
  assert.equal(DEFAULT_CONFIG.redGreen, true);
  assert.equal(DEFAULT_CONFIG.reviewEachTask, true);
  assert.equal(DEFAULT_CONFIG.fixerLadder, undefined);
});

test('loadConfig lee redGreen, reviewEachTask y fixerLadder del proyecto', () => {
  const repo = tmp();
  const cfgPath = join(repo, 'orcatech.config.json');
  writeFileSync(cfgPath, JSON.stringify({ redGreen: false, reviewEachTask: false, fixerLadder: ['codex', 'claude-personal:claude-opus-5-5'] }));
  const cfg = loadConfig(repo);
  assert.equal(cfg.redGreen, false);
  assert.equal(cfg.reviewEachTask, false);
  assert.deepEqual(cfg.fixerLadder, ['codex', 'claude-personal:claude-opus-5-5']);

  // Un override que no trae las claves (o las trae undefined) no borra lo heredado.
  const kept = loadConfig(repo, { fixerLadder: undefined });
  assert.deepEqual(kept.fixerLadder, ['codex', 'claude-personal:claude-opus-5-5']);
  assert.equal(kept.redGreen, false);
  // El array del override reemplaza al base, no se concatena.
  assert.deepEqual(loadConfig(repo, { fixerLadder: ['claude-work'] }).fixerLadder, ['claude-work']);

  writeFileSync(cfgPath, JSON.stringify({}));
  const defaults = loadConfig(repo);
  assert.equal(defaults.redGreen, true);
  assert.equal(defaults.reviewEachTask, true);
  assert.equal(defaults.fixerLadder, undefined);

  writeFileSync(cfgPath, JSON.stringify({ fixerLadder: ['codex', 'x:modelo'] }));
  assert.throws(() => loadConfig(repo), /fixerLadder\[1\] apunta a la cuenta inexistente "x"/);
});

test('ladderSpec elige el escalón según el intento', () => {
  assert.equal(ladderSpec(undefined, 1), undefined);
  assert.equal(ladderSpec([], 2), undefined);
  assert.equal(ladderSpec(['a', 'b'], 1), 'a');
  assert.equal(ladderSpec(['a', 'b'], 2), 'b');
  assert.equal(ladderSpec(['a', 'b'], 5), 'b');
  assert.equal(ladderSpec(['a', 'b'], 0), 'a');
  assert.equal(ladderSpec(['a', 'b'], -3), 'a');
});

test('resolveFixerRole sin fixerLadder devuelve exactamente roles.fixer', () => {
  const roles = DEFAULT_CONFIG.roles;
  for (const attempt of [1, 2, 5]) {
    assert.equal(resolveFixerRole({ accounts: DEFAULT_CONFIG.accounts }, roles, attempt), roles.fixer);
    assert.equal(resolveFixerRole({ accounts: DEFAULT_CONFIG.accounts, fixerLadder: [] }, roles, attempt), roles.fixer);
  }
});

test('resolveFixerRole aplica el escalón de la escalera según el intento', () => {
  const cfg = { accounts: DEFAULT_CONFIG.accounts, fixerLadder: ['codex', 'claude-personal:claude-opus-5-5'] };
  const roles = { ...DEFAULT_CONFIG.roles, fixer: { account: 'claude-work', model: 'claude-sonnet-5-5', effort: 'high' as const, maxBudgetUsd: 2 } };

  const first = resolveFixerRole(cfg, roles, 1);
  assert.equal(first.account, 'codex');
  assert.equal(first.model, undefined); // el modelo de Claude no aplica en codex
  assert.equal(first.maxBudgetUsd, 2);

  for (const attempt of [2, 5]) {
    const r = resolveFixerRole(cfg, roles, attempt);
    assert.equal(r.account, 'claude-personal');
    assert.equal(r.model, 'claude-opus-5-5');
    assert.equal(r.effort, 'high');
  }
  // No muta el rol base.
  assert.equal(roles.fixer.account, 'claude-work');
});

test('detectProject reconoce Laravel, juego de navegador y Python', () => {
  const lara = tmp();
  writeFileSync(join(lara, 'artisan'), '');
  writeFileSync(join(lara, 'composer.json'), '{}');
  assert.equal(detectProject(lara).type, 'laravel');
  assert.equal(detectProject(lara).testCommand, 'php artisan test');

  const game = tmp();
  writeFileSync(join(game, 'package.json'), JSON.stringify({ name: 'last-zone', scripts: { test: 'vitest run', typecheck: 'tsc' }, devDependencies: { '@playwright/test': '1' } }));
  writeFileSync(join(game, 'README.md'), '# Last Zone\n\nAn original top-down battle royale for the browser');
  const g = detectProject(game);
  assert.equal(g.type, 'browser-game');
  assert.equal(g.testCommand, 'npm run typecheck && npm test && npx playwright test');

  const py = tmp();
  writeFileSync(join(py, 'requirements.txt'), '');
  assert.equal(detectProject(py).type, 'python');
});

test('los esquemas son estrictos (requeridos todos y sin propiedades extra) para Codex', () => {
  const check = (s: any) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(check);
    }
    if (s.type === 'array') check(s.items);
  };
  [PLAN_SCHEMA, TEST_SCHEMA, REVIEW_SCHEMA].forEach(check);
});

test('isTestFile reconoce tests de varios lenguajes y rechaza código fuente', () => {
  for (const p of ['test/core.test.ts', 'src/foo.spec.ts', 'tests/Feature/UserTest.php', 'tests/test_api.py', 'pkg/x_test.go', 'app/test_api.py', 'lib/api_test.py', 'src/__tests__/a.js', 'spec/models/user_spec.rb']) {
    assert.equal(isTestFile(p), true, p);
  }
  for (const p of ['src/pipeline.ts', 'src/testing.ts', 'src/latest.ts', 'README.md', 'src/contest/main.go']) {
    assert.equal(isTestFile(p), false, p);
  }
});

test('pickTestFiles devuelve tests agregados/modificados y el destino de renombres, sin borrados', () => {
  assert.deepEqual(
    pickTestFiles([
      { status: 'A', path: 'test/a.test.ts' },
      { status: 'M', path: 'test/b.test.ts' },
      { status: 'D', path: 'test/c.test.ts' },
      { status: 'M', path: 'src/x.ts' },
    ]),
    ['test/a.test.ts', 'test/b.test.ts'],
  );
  assert.deepEqual(pickTestFiles([{ status: 'R100', path: 'test/nuevo.test.ts' }]), ['test/nuevo.test.ts']);
});

test('newSourceFiles devuelve solo archivos nuevos que no son tests', () => {
  assert.deepEqual(
    newSourceFiles([
      { status: 'A', path: 'src/redgreen.ts' },
      { status: 'A', path: 'test/redgreen.test.ts' },
      { status: 'M', path: 'src/store.ts' },
      { status: 'D', path: 'src/viejo.ts' },
    ]),
    ['src/redgreen.ts'],
  );
});

test('classifyRedRun: code 0 es not-red, fallo de aserción es proven, code null es inconclusive', () => {
  const ctx = { testFiles: ['test/a.test.ts'], newFiles: [] };
  assert.equal(classifyRedRun({ code: 0, output: 'ok' }, ctx).status, 'not-red');
  assert.equal(classifyRedRun({ code: 1, output: 'AssertionError: expected 2 got 1' }, ctx).status, 'proven');
  assert.equal(classifyRedRun({ code: null, output: '' }, ctx).status, 'inconclusive');
});

test('classifyRedRun: errores de carga o compilación son inconclusive', () => {
  const output = 'Error [ERR_MODULE_NOT_FOUND]: Cannot find module ../src/redgreen.ts';
  const sinNuevo = classifyRedRun({ code: 1, output }, { testFiles: ['test/core.test.ts'], newFiles: [] });
  assert.equal(sinNuevo.status, 'inconclusive');
  assert.doesNotMatch(sinNuevo.detail, /módulo nuevo/);
  const conNuevo = classifyRedRun({ code: 1, output }, { testFiles: ['test/core.test.ts'], newFiles: ['src/redgreen.ts'] });
  assert.equal(conNuevo.status, 'inconclusive');
  assert.match(conNuevo.detail, /módulo nuevo/);
  assert.match(conNuevo.detail, /src\/redgreen\.ts/);
  const ctx = { testFiles: ['test/a.test.ts'], newFiles: [] };
  for (const out of [
    "test/a.test.ts(3,1): error TS2307: Cannot find module './x'",
    'SyntaxError: Unexpected token',
    "ModuleNotFoundError: No module named 'app.api'",
    'Failed to resolve import "./nuevo" from "test/a.test.ts"',
    'Error: Class "App\\Models\\Invoice" not found',
    'PHP Parse error: syntax error, unexpected token',
  ]) {
    assert.equal(classifyRedRun({ code: 1, output: out }, ctx).status, 'inconclusive', out);
  }
});

test('classifyRedRun: errores de infraestructura y salidas desconocidas son inconclusive, no proven', () => {
  const ctx = { testFiles: ['test/a.test.ts'], newFiles: [] };
  // Comando inexistente (127) o no ejecutable (126), aunque la salida parezca un fallo.
  assert.equal(classifyRedRun({ code: 127, output: 'sh: phpunit: command not found' }, ctx).status, 'inconclusive');
  assert.equal(classifyRedRun({ code: 127, output: 'not ok 1 - x' }, ctx).status, 'inconclusive');
  assert.equal(classifyRedRun({ code: 126, output: 'sh: ./run: Permission denied' }, ctx).status, 'inconclusive');
  for (const out of [
    'sh: 1: pytest: not found',
    'Error: connect ECONNREFUSED 127.0.0.1:5432\nnot ok 1 - crea usuario\n# fail 1',
    'SQLSTATE[HY000] [2002] Connection refused\nFAILURES!',
    'psql: error: could not connect to server: No such file or directory',
    "SQLSTATE[HY000] [1045] Access denied for user 'root'@'localhost'",
    'getaddrinfo ENOTFOUND db',
    'npm ERR! Missing script: "test"',
    'Error: Missing required environment variable DATABASE_URL',
    'No application encryption key has been specified.',
    'Could not open input file: artisan',
    'algo salió mal', // salida desconocida: sin señal de aserción
    '',
  ]) {
    const r = classifyRedRun({ code: 1, output: out }, ctx);
    assert.equal(r.status, 'inconclusive', out);
  }
  // Fallos de aserción reales de distintos runners siguen siendo proven.
  for (const out of [
    'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal',
    'not ok 1 - sum\n# fail 1',
    'ℹ fail 1',
    'Tests:       1 failed, 3 passed, 4 total',
    '  1 failing',
    'FAILED tests/test_api.py::test_sum - assert 1 == 2',
    'Failed asserting that 1 is identical to 2.\nFAILURES!',
    '--- FAIL: TestSum (0.00s)',
    "thread 'sum' panicked at 'assertion failed: `(left == right)`'",
    'expected 2 to equal 3',
  ]) {
    assert.equal(classifyRedRun({ code: 1, output: out }, ctx).status, 'proven', out);
  }
});

test('RunState acepta el resultado de la prueba red→green por tarea', () => {
  const tasks: RunState['tasks'] = {
    T1: { status: 'passed', attempts: 1, account: 'codex', proof: { status: 'proven', detail: 'ok', testFiles: ['test/a.test.ts'] } },
    T2: { status: 'passed', attempts: 1, account: 'codex' },
  };
  assert.equal(tasks.T1.proof?.status, 'proven');
  assert.equal(tasks.T2.proof, undefined);
});

function reportState(tasks: RunState['tasks']): RunState {
  const now = new Date().toISOString();
  const planTask = (id: string) => ({ id, title: `Tarea ${id}`, description: 'd', kind: 'backend', acceptance: [] });
  return {
    id: 'r1', idea: 'idea', repo: '/tmp/x', status: 'done', createdAt: now, updatedAt: now, projectType: 'node',
    roles: DEFAULT_CONFIG.roles,
    plan: { summary: 's', testCommand: 'npm test', tasks: Object.keys(tasks).map(planTask) } as unknown as Plan,
    tasks, steps: [], costUsd: 0, tokens: { input: 0, output: 0 },
  };
}

test('renderReport muestra la prueba red→green, la revisión por tarea y el detail de las no probadas', () => {
  const md = renderReport(reportState({
    T1: { status: 'passed', attempts: 0, account: 'codex', commit: 'aaa', proof: { status: 'proven', detail: 'falló sin el cambio', testFiles: ['test/a.test.ts'] },
      review: { verdict: 'changes', summary: 's', issues: [{ severity: 'high', file: 'a.ts', description: 'x' }, { severity: 'low', file: 'a.ts', description: 'y' }] } },
    T2: { status: 'passed', attempts: 1, account: 'codex', proof: { status: 'not-red', detail: 'los tests pasan en el commit previo', testFiles: ['test/b.test.ts'] } },
    T3: { status: 'passed', attempts: 0, account: 'codex' },
  }));
  assert.match(md, /\[T1\] Tarea T1 .*🟢 red→green probado · revisión: changes, 1 high/);
  assert.match(md, /\[T2\] Tarea T2 .*🟠 tests no fallan sin el cambio/);
  assert.match(md, /## Prueba red→green\n- \[T2\] 🟠 tests no fallan sin el cambio: los tests pasan en el commit previo/);
  assert.doesNotMatch(md, /- \[T1\] 🟢/, 'las tareas proven no van en la sección de detalle');
  const t3 = md.split('\n').find((l) => l.includes('[T3]'));
  assert.equal(t3, '- ✅ [T3] Tarea T3 — codex');
});

test('renderReport de una corrida vieja sin proof ni review no incluye la sección red→green', () => {
  const md = renderReport(reportState({ T1: { status: 'passed', attempts: 0, account: 'codex' } }));
  assert.doesNotMatch(md, /red→green/);
  assert.equal(PROOF_LABELS.skipped, '⏭ prueba omitida');
  assert.equal(PROOF_LABELS['no-tests'], '⚪ sin tests nuevos');
  assert.equal(PROOF_LABELS.inconclusive, '➖ prueba no concluyente');
});

// ---- Integración con un repo git temporal real ----

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function gitRepo(): string {
  const repo = tmp();
  sh(repo, 'init', '-q');
  sh(repo, 'config', 'user.email', 'test@orcatech.dev');
  sh(repo, 'config', 'user.name', 'orcatech test');
  sh(repo, 'config', 'commit.gpgsign', 'false');
  return repo;
}

function put(repo: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
}

function commit(repo: string, msg: string): string {
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', msg);
  return sh(repo, 'rev-parse', 'HEAD');
}

const worktrees = (repo: string) => sh(repo, 'worktree', 'list').split('\n').filter(Boolean);
const redDirs = () => new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('orcatech-red-')));

const SUM_BUG = 'module.exports = (a, b) => a - b;\n';
const SUM_OK = 'module.exports = (a, b) => a + b;\n';
const SUM_TEST = [
  "const { test } = require('node:test');",
  "const assert = require('node:assert');",
  "const sum = require('../src/sum.js');",
  "test('sum', () => assert.strictEqual(sum(2, 3), 5));",
  '',
].join('\n');

/** Corre runRedCheck y verifica que no quede worktree ni tmpdir. */
async function redCheck(repo: string, pre: string, post: string, testCommand: string) {
  const before = redDirs();
  const proof = await runRedCheck({ repo, preCommit: pre, postCommit: post, testCommand, timeoutMs: 60_000 });
  assert.equal(worktrees(repo).length, 1, 'solo debe quedar el worktree principal');
  const leaked = [...redDirs()].filter((d) => !before.has(d));
  assert.deepEqual(leaked, [], 'el tmpdir debe borrarse');
  return proof;
}

test('changedFiles, diffRange, showFile y headCommit sobre un repo temporal', async () => {
  const repo = gitRepo();
  put(repo, { 'a.txt': 'uno\n', 'b.txt': 'dos\n', 'c.txt': 'contenido largo que se renombra sin cambios\n' });
  const c1 = commit(repo, 'c1');
  put(repo, { 'a.txt': 'uno modificado\n', 'nuevo.txt': 'nuevo\n' });
  rmSync(join(repo, 'b.txt'));
  renameSync(join(repo, 'c.txt'), join(repo, 'd.txt'));
  const c2 = commit(repo, 'c2');

  assert.equal(await headCommit(repo), c2);
  assert.match(c2, /^[0-9a-f]{40}$/);

  const changes = await changedFiles(repo, c1, c2);
  const byPath = Object.fromEntries(changes.map((c) => [c.path, c.status]));
  assert.deepEqual(byPath, { 'a.txt': 'M', 'b.txt': 'D', 'd.txt': 'R', 'nuevo.txt': 'A' });

  const diff = await diffRange(repo, c1, c2);
  assert.match(diff, /uno modificado/);
  assert.match(await diffRange(repo, c1, c2, 10), /diff recortado/);

  assert.equal(await showFile(repo, c1, 'a.txt'), 'uno\n');
  assert.equal(await showFile(repo, c2, 'a.txt'), 'uno modificado\n');
});

test('runRedCheck: el test que corrige un bug falla en el commit previo → proven', async () => {
  const repo = gitRepo();
  put(repo, { 'src/sum.js': SUM_BUG });
  const pre = commit(repo, 'sum con bug');
  put(repo, { 'src/sum.js': SUM_OK, 'test/sum.test.js': SUM_TEST });
  const post = commit(repo, 'corrige sum y agrega test');

  const proof = await redCheck(repo, pre, post, 'node --test test/*.test.js');
  assert.equal(proof.status, 'proven', proof.detail);
  assert.deepEqual(proof.testFiles, ['test/sum.test.js']);
  // El repo principal no se tocó.
  assert.equal(readFileSync(join(repo, 'src/sum.js'), 'utf8'), SUM_OK);
});

test('runRedCheck: un test que ya pasaba antes → not-red; sin tests → no-tests', async () => {
  const repo = gitRepo();
  put(repo, { 'src/sum.js': SUM_OK });
  const pre = commit(repo, 'sum correcto');
  put(repo, { 'test/sum.test.js': SUM_TEST, 'README.md': 'docs\n' });
  const post = commit(repo, 'solo agrega test');
  const proof = await redCheck(repo, pre, post, 'node --test test/*.test.js');
  assert.equal(proof.status, 'not-red', proof.detail);

  put(repo, { 'src/otro.js': 'module.exports = 1;\n' });
  const post2 = commit(repo, 'sin tests');
  const none = await redCheck(repo, post, post2, 'node --test test/*.test.js');
  assert.equal(none.status, 'no-tests');
  assert.deepEqual(none.testFiles, []);
});

test('runRedCheck limpia el worktree aunque el comando falle o el commit no exista', async () => {
  const repo = gitRepo();
  put(repo, { 'src/sum.js': SUM_BUG });
  const pre = commit(repo, 'c1');
  put(repo, { 'test/sum.test.js': SUM_TEST });
  const post = commit(repo, 'c2');

  // El comando anota su cwd (el worktree) y falla con un comando inexistente.
  const marker = join(tmp(), 'cwd.txt');
  const failed = await redCheck(repo, pre, post, `pwd > '${marker}'; comando-que-no-existe-xyz`);
  assert.notEqual(failed.status, 'no-tests');
  const wt = readFileSync(marker, 'utf8').trim();
  assert.match(wt, /orcatech-red-/);
  assert.equal(existsSync(wt), false);

  // Un comando inexistente nunca es una prueba válida.
  assert.equal(failed.status, 'inconclusive', failed.detail);

  // Commit previo inválido: worktree add falla → inconclusive, sin lanzar.
  const bad = await redCheck(repo, '0'.repeat(40), post, 'true');
  assert.equal(bad.status, 'inconclusive');
  assert.ok(bad.detail.length > 0);
});

test('runRedCheck no escribe fuera del worktree a través de symlinks del commit previo', async () => {
  const outside = tmp();
  const victim = join(outside, 'victima.txt');
  writeFileSync(victim, 'intacto\n');

  // 1) El test modificado era un symlink a un archivo externo.
  const repo = gitRepo();
  put(repo, { 'src/sum.js': SUM_BUG });
  symlinkSync(victim, join(repo, 'evil.test.js'));
  const pre = commit(repo, 'test como symlink externo');
  rmSync(join(repo, 'evil.test.js'));
  symlinkSync(join(outside, 'otro.txt'), join(repo, 'evil.test.js'));
  const post = commit(repo, 'cambia el destino del symlink');
  const proof = await redCheck(repo, pre, post, 'true');
  assert.notEqual(proof.status, 'no-tests');
  assert.equal(readFileSync(victim, 'utf8'), 'intacto\n', 'el archivo externo no debe sobrescribirse');

  // 2) Un directorio intermedio era un symlink a un directorio externo.
  const repo2 = gitRepo();
  put(repo2, { 'src/sum.js': SUM_BUG });
  mkdirSync(join(repo2, 'test'));
  symlinkSync(outside, join(repo2, 'test/fx'), 'dir');
  const pre2 = commit(repo2, 'test/fx es symlink externo');
  rmSync(join(repo2, 'test/fx'));
  put(repo2, { 'test/fx/a.test.js': SUM_TEST });
  const post2 = commit(repo2, 'test/fx pasa a ser directorio');
  const proof2 = await redCheck(repo2, pre2, post2, 'node --test test/fx/*.test.js');
  assert.equal(proof2.status, 'inconclusive', proof2.detail);
  assert.match(proof2.detail, /enlace simbólico/);
  assert.equal(existsSync(join(outside, 'a.test.js')), false, 'no debe crearse nada fuera del worktree');
  assert.deepEqual(readdirSync(outside).sort(), ['victima.txt']);
});

/** Repo con un vendor/ estilo Composer cuyo autoloader resuelve el código de la app desde vendor/composer/../.. */
function composerLikeRepo(): { repo: string; pre: string; post: string } {
  const repo = gitRepo();
  put(repo, {
    '.gitignore': 'vendor/\n',
    'src/sum.js': SUM_BUG,
    // Igual que Composer: $baseDir = dirname(dirname(__DIR__)), y __DIR__ resuelve symlinks.
    'vendor/autoload.cjs': "module.exports = require('./composer/autoload_real.cjs');\n",
    'vendor/composer/autoload_real.cjs': [
      "const path = require('node:path');",
      'const baseDir = path.dirname(path.dirname(__dirname));',
      "module.exports = (name) => require(path.join(baseDir, 'src', name));",
      '',
    ].join('\n'),
    'vendor/acme/lib/index.cjs': 'module.exports = 42;\n',
  });
  const pre = commit(repo, 'sum con bug');
  put(repo, {
    'src/sum.js': SUM_OK,
    'test/sum.test.js': [
      "const { test } = require('node:test');",
      "const assert = require('node:assert');",
      "const load = require('../vendor/autoload.cjs');",
      "test('sum', () => {",
      "  assert.strictEqual(require('../vendor/acme/lib/index.cjs'), 42);",
      "  assert.strictEqual(load('sum.js')(2, 3), 5);",
      '});',
      '',
    ].join('\n'),
  });
  return { repo, pre, post: commit(repo, 'corrige sum') };
}

test('runRedCheck: el autoload estilo Composer resuelve el código de la app dentro del worktree', async () => {
  const { repo, pre, post } = composerLikeRepo();
  const proof = await redCheck(repo, pre, post, 'node --test test/*.test.js');
  assert.equal(proof.status, 'proven', proof.detail);
  // vendor del repo principal intacto.
  assert.ok(existsSync(join(repo, 'vendor/composer/autoload_real.cjs')));
  assert.ok(existsSync(join(repo, 'vendor/acme/lib/index.cjs')));
});

const hasComposer = (() => {
  try {
    execFileSync('php', ['--version'], { stdio: 'ignore' });
    execFileSync('composer', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('runRedCheck con Composer real: el autoloader carga el código previo del worktree', { skip: !hasComposer && 'requiere php y composer' }, async () => {
  const repo = gitRepo();
  const calc = (op: string) => `<?php\nnamespace App;\nclass Calc { public static function sum($a, $b) { return $a ${op} $b; } }\n`;
  put(repo, {
    '.gitignore': 'vendor/\n',
    'composer.json': JSON.stringify({ name: 'orcatech/red', autoload: { 'psr-4': { 'App\\': 'src/' } } }),
    'src/Calc.php': calc('-'),
  });
  const pre = commit(repo, 'calc con bug');
  execFileSync('composer', ['dump-autoload', '--quiet', '--no-interaction'], { cwd: repo, stdio: 'ignore' });
  assert.ok(existsSync(join(repo, 'vendor/composer/autoload_psr4.php')));
  put(repo, {
    'src/Calc.php': calc('+'),
    'tests/CalcTest.php': "<?php\nrequire __DIR__ . '/../vendor/autoload.php';\nassert(\\App\\Calc::sum(2, 3) === 5);\necho \"ok\\n\";\n",
  });
  const post = commit(repo, 'corrige calc');
  const cmd = 'php -d zend.assertions=1 -d assert.exception=1 tests/CalcTest.php';
  execFileSync('sh', ['-c', cmd], { cwd: repo }); // pasa con la tarea
  const proof = await redCheck(repo, pre, post, cmd);
  assert.equal(proof.status, 'proven', proof.detail);
});

// ---- Integración de la prueba red→green en el loop de tareas (proveTask) ----

test('strengthenTestsPrompt está en español e incluye los archivos de test y el detail', () => {
  const p = strengthenTestsPrompt('Tu tarea: [T9] Algo', { detail: 'Los tests pasan sobre el código previo.', testFiles: ['test/a.test.ts', 'test/b.test.ts'] });
  assert.match(p, /Tu tarea: \[T9\] Algo/);
  assert.match(p, /test\/a\.test\.ts/);
  assert.match(p, /test\/b\.test\.ts/);
  assert.match(p, /Los tests pasan sobre el código previo\./);
  assert.match(p, /Refuerza/);
  assert.match(p, /FALLEN sin la implementación/);
  assert.match(p, /No debilites/);
});

test('proofLogText usa ✓ para proven, ⚠ para not-red y ➖ para inconclusive', () => {
  const p = (status: TaskProof['status']): TaskProof => ({ status, detail: 'd', testFiles: [] });
  assert.match(proofLogText('T1', p('proven')), /^✓ .*\[T1\].*proven/);
  assert.match(proofLogText('T1', p('not-red')), /^⚠ /);
  assert.match(proofLogText('T1', p('inconclusive')), /^➖ /);
});

/** Dependencias falsas que registran cada llamada. */
function fakeDeps(proofs: (TaskProof | Error)[], over: Partial<ProofDeps> = {}) {
  const calls = { redCheck: [] as { preCommit: string; postCommit: string }[], fix: [] as { attempt: number; prompt: string }[], commits: [] as string[], tests: 0, saves: 0, logs: [] as string[] };
  let head = 0;
  const deps: ProofDeps = {
    redCheck: async (o) => {
      calls.redCheck.push({ preCommit: o.preCommit, postCommit: o.postCommit });
      const next = proofs.shift() ?? { status: 'proven', detail: 'ok', testFiles: [] };
      if (next instanceof Error) throw next;
      return next;
    },
    head: async () => `post${++head}`,
    fix: async (attempt, prompt) => void calls.fix.push({ attempt, prompt }),
    runTests: async () => (calls.tests++, { ok: true, output: '' }),
    commit: async (m) => (calls.commits.push(m), 'abc1234'),
    status: () => undefined,
    log: (t) => void calls.logs.push(t),
    save: () => void calls.saves++,
    ...over,
  };
  return { deps, calls };
}

function proofInput(record: Partial<TaskRecord> = {}, over: Partial<ProofInput> = {}): ProofInput {
  return {
    taskId: 'T1',
    record: { status: 'passed', attempts: 0, account: 'codex', commit: 'c0ffee1', ...record },
    context: 'Tu tarea: [T1] Sumar',
    repo: '/no/importa',
    testCommand: 'npm test',
    preCommit: 'pre',
    redGreen: true,
    git: true,
    maxFixAttempts: 3,
    ...over,
  };
}

test('proveTask: redGreen=false, sin git o sin testCommand → skipped sin correr la prueba', async () => {
  for (const over of [{ redGreen: false }, { git: false, preCommit: undefined }, { testCommand: '' }]) {
    const { deps, calls } = fakeDeps([]);
    const input = proofInput({}, over);
    const proof = await proveTask(input, deps);
    assert.equal(proof.status, 'skipped', JSON.stringify(over));
    assert.equal(input.record.proof?.status, 'skipped');
    assert.ok(proof.detail.length > 0);
    assert.equal(calls.redCheck.length, 0);
    assert.ok(calls.saves > 0);
  }
  // Tarea fallida → skipped; tarea sin commit → no-tests.
  assert.equal((await proveTask(proofInput({ status: 'failed' }), fakeDeps([]).deps)).status, 'skipped');
  const noCommit = fakeDeps([]);
  assert.equal((await proveTask(proofInput({ commit: undefined }), noCommit.deps)).status, 'no-tests');
  assert.equal(noCommit.calls.redCheck.length, 0);
});

test('proveTask: proven queda registrado y no llama al reparador', async () => {
  const { deps, calls } = fakeDeps([{ status: 'proven', detail: 'falla antes', testFiles: ['test/a.test.ts'] }]);
  const input = proofInput();
  const proof = await proveTask(input, deps);
  assert.equal(proof.status, 'proven');
  assert.equal(input.record.proof?.status, 'proven');
  assert.deepEqual(calls.redCheck, [{ preCommit: 'pre', postCommit: 'post1' }]);
  assert.equal(calls.fix.length, 0);
  assert.equal(input.record.attempts, 0);
  assert.ok(calls.logs.some((l) => l.startsWith('✓ ')));
});

test('proveTask: not-red → un refuerzo del reparador, attempts+1, commit y se repite la prueba con el mismo pre', async () => {
  const notRed: TaskProof = { status: 'not-red', detail: 'pasan sobre el código previo', testFiles: ['test/a.test.ts'] };
  const { deps, calls } = fakeDeps([notRed, { status: 'proven', detail: 'ahora falla antes', testFiles: ['test/a.test.ts'] }]);
  const input = proofInput({ attempts: 1 });
  const proof = await proveTask(input, deps);
  assert.equal(proof.status, 'proven');
  assert.equal(input.record.proof?.status, 'proven');
  assert.equal(input.record.attempts, 2);
  assert.equal(calls.fix.length, 1);
  assert.equal(calls.fix[0].attempt, 2);
  assert.equal(calls.fix[0].prompt, strengthenTestsPrompt(input.context, notRed));
  assert.equal(calls.tests, 1);
  assert.deepEqual(calls.commits, ['orcatech: [T1] refuerzo de tests']);
  assert.equal(input.record.commit, 'abc1234');
  assert.deepEqual(calls.redCheck, [
    { preCommit: 'pre', postCommit: 'post1' },
    { preCommit: 'pre', postCommit: 'post2' },
  ]);
  assert.ok(calls.logs.some((l) => l.startsWith('⚠ ')));
});

test('proveTask: not-red repetido no vuelve a llamar al reparador (una sola vez)', async () => {
  const notRed: TaskProof = { status: 'not-red', detail: 'x', testFiles: [] };
  const { deps, calls } = fakeDeps([notRed, notRed]);
  const input = proofInput();
  assert.equal((await proveTask(input, deps)).status, 'not-red');
  assert.equal(calls.fix.length, 1);
  assert.equal(calls.redCheck.length, 2);
  assert.equal(input.record.attempts, 1);
});

test('proveTask: not-red sin intentos restantes se conserva sin llamar al reparador', async () => {
  const { deps, calls } = fakeDeps([{ status: 'not-red', detail: 'x', testFiles: [] }]);
  const input = proofInput({ attempts: 3 });
  const proof = await proveTask(input, deps);
  assert.equal(proof.status, 'not-red');
  assert.equal(input.record.proof?.status, 'not-red');
  assert.equal(input.record.attempts, 3);
  assert.equal(calls.fix.length, 0);
  assert.equal(calls.redCheck.length, 1);
});

test('proveTask: si los tests dejan de pasar tras el refuerzo, la tarea queda failed', async () => {
  const { deps, calls } = fakeDeps([{ status: 'not-red', detail: 'x', testFiles: [] }], { runTests: async () => ({ ok: false, output: 'boom' }) });
  const input = proofInput();
  await proveTask(input, deps);
  assert.equal(input.record.status, 'failed');
  assert.equal(input.record.attempts, 1);
  assert.equal(calls.redCheck.length, 1);
  assert.match(calls.commits[0], /refuerzo de tests \(tests fallando\)/);
});

test('proveTask: una excepción en la prueba no corta la corrida → inconclusive', async () => {
  const { deps } = fakeDeps([new Error('worktree roto')]);
  const input = proofInput();
  const proof = await proveTask(input, deps);
  assert.equal(proof.status, 'inconclusive');
  assert.match(proof.detail, /worktree roto/);
  assert.equal(input.record.proof?.status, 'inconclusive');

  const headFails = fakeDeps([], { head: async () => { throw new Error('sin HEAD'); } });
  assert.equal((await proveTask(proofInput(), headFails.deps)).status, 'inconclusive');
});

test('proveTask con git real: la tarea cuyo test falla en el commit previo queda proven', async () => {
  const repo = gitRepo();
  put(repo, { 'src/sum.js': SUM_BUG });
  const pre = commit(repo, 'sum con bug');
  put(repo, { 'src/sum.js': SUM_OK, 'test/sum.test.js': SUM_TEST });
  const post = commit(repo, '[T1] corrige sum');
  const { deps, calls } = fakeDeps([], { redCheck: (o) => runRedCheck({ ...o, timeoutMs: 60_000 }), head: headCommit });
  const input = proofInput({ commit: post.slice(0, 7) }, { repo, preCommit: pre, testCommand: 'node --test test/*.test.js' });
  const proof = await proveTask(input, deps);
  assert.equal(proof.status, 'proven', proof.detail);
  assert.deepEqual(proof.testFiles, ['test/sum.test.js']);
  assert.equal(calls.fix.length, 0);
  assert.equal(worktrees(repo).length, 1);
});

// ---- Revisión por tarea (reviewTask) ----

const REVIEW_MIXED: Review = {
  verdict: 'changes',
  summary: 'hay problemas',
  issues: [
    { severity: 'high', file: 'src/a.ts', description: 'división por cero' },
    { severity: 'medium', file: 'src/b.ts', description: 'nombre confuso' },
    { severity: 'low', file: 'src/c.ts', description: 'typo' },
    { severity: 'high', file: 'src/d.ts', description: 'inyección SQL' },
  ],
};

test('highIssues filtra solo severity high y devuelve [] con undefined', () => {
  assert.deepEqual(highIssues(undefined), []);
  assert.deepEqual(highIssues(), []);
  assert.deepEqual(highIssues({ verdict: 'approve', summary: '', issues: [] }), []);
  assert.deepEqual(highIssues(REVIEW_MIXED).map((i) => i.file), ['src/a.ts', 'src/d.ts']);
  assert.deepEqual(highIssues({ ...REVIEW_MIXED, issues: REVIEW_MIXED.issues.filter((i) => i.severity !== 'high') }), []);
});

test('taskReviewPrompt está en español, acota a la tarea e incluye criterios y diff', () => {
  const plan: Plan = {
    summary: 'Calculadora',
    testCommand: 'npm test',
    risks: [],
    tasks: [
      { id: 'T1', title: 'Sumar', kind: 'backend', description: 'Implementa sum', acceptance: ['sum(1,2) es 3'], files: [] },
      { id: 'T2', title: 'Restar', kind: 'backend', description: 'Implementa sub', acceptance: ['sub(3,1) es 2'], files: [] },
    ],
  };
  const p = taskReviewPrompt(plan, plan.tasks[0], 'diff --git a/src/sum.js');
  assert.match(p, /Revisa SOLO esta tarea: \[T1\] Sumar/);
  assert.match(p, /- sum\(1,2\) es 3/);
  assert.match(p, /diff --git a\/src\/sum\.js/);
  assert.match(p, /criterios de aceptación/i);
  assert.doesNotMatch(p, /sub\(3,1\)/);
});

function fakeReviewDeps(review: Review | undefined, over: Partial<TaskReviewDeps> = {}) {
  const calls = { diff: 0, review: [] as string[], fix: [] as { attempt: number; prompt: string }[], commits: [] as string[], tests: 0, saves: 0, logs: [] as string[] };
  const deps: TaskReviewDeps = {
    diff: async () => (calls.diff++, 'el diff'),
    review: async (d) => (calls.review.push(d), review),
    fix: async (attempt, prompt) => void calls.fix.push({ attempt, prompt }),
    runTests: async () => (calls.tests++, { ok: true, output: '' }),
    commit: async (m) => (calls.commits.push(m), 'fix1234'),
    status: () => undefined,
    log: (t) => void calls.logs.push(t),
    save: () => void calls.saves++,
    ...over,
  };
  return { deps, calls };
}

function reviewInput(record: Partial<TaskRecord> = {}, over: Partial<TaskReviewInput> = {}): TaskReviewInput {
  return {
    taskId: 'T1',
    record: { status: 'passed', attempts: 0, account: 'codex', commit: 'c0ffee1', ...record },
    context: 'Tu tarea: [T1] Sumar',
    testCommand: 'npm test',
    reviewEachTask: true,
    git: true,
    maxFixAttempts: 3,
    ...over,
  };
}

test('reviewTask: reviewEachTask=false, sin git o sin commit no llama al revisor', async () => {
  for (const [rec, over] of [[{}, { reviewEachTask: false }], [{}, { git: false }], [{ commit: undefined }, {}]] as [Partial<TaskRecord>, Partial<TaskReviewInput>][]) {
    const { deps, calls } = fakeReviewDeps(REVIEW_MIXED);
    const input = reviewInput(rec, over);
    assert.equal(await reviewTask(input, deps), undefined);
    assert.equal(calls.review.length, 0);
    assert.equal(calls.diff, 0);
    assert.equal(input.record.review, undefined);
  }
});

test('reviewTask: sin hallazgos high guarda la revisión y no llama al reparador', async () => {
  const onlyMinor: Review = { ...REVIEW_MIXED, verdict: 'approve', issues: REVIEW_MIXED.issues.filter((i) => i.severity !== 'high') };
  const { deps, calls } = fakeReviewDeps(onlyMinor);
  const input = reviewInput();
  const r = await reviewTask(input, deps);
  assert.equal(r, onlyMinor);
  assert.equal(input.record.review, onlyMinor);
  assert.deepEqual(calls.review, ['el diff']);
  assert.equal(calls.fix.length, 0);
  assert.equal(calls.tests, 0);
  assert.equal(calls.commits.length, 0);
  assert.equal(input.record.attempts, 0);
});

test('reviewTask: hallazgos high → una reparación, re-test y commit; sin re-revisión', async () => {
  const { deps, calls } = fakeReviewDeps(REVIEW_MIXED);
  const input = reviewInput({ attempts: 1 });
  await reviewTask(input, deps);
  assert.equal(input.record.review, REVIEW_MIXED);
  assert.equal(calls.review.length, 1);
  assert.equal(calls.fix.length, 1);
  assert.equal(calls.fix[0].attempt, 2);
  assert.match(calls.fix[0].prompt, /src\/a\.ts: división por cero/);
  assert.match(calls.fix[0].prompt, /src\/d\.ts: inyección SQL/);
  assert.doesNotMatch(calls.fix[0].prompt, /nombre confuso|typo/);
  assert.ok(calls.fix[0].prompt.startsWith(fixPrompt(input.context, '').split('\n\nLos tests')[0]));
  assert.equal(calls.tests, 1);
  assert.deepEqual(calls.commits, ['orcatech: [T1] correcciones de revisión']);
  assert.equal(input.record.commit, 'fix1234');
  assert.equal(input.record.attempts, 2);
  assert.equal(input.record.status, 'passed');
});

test('reviewTask: los intentos se comparten con maxFixAttempts y, si los tests siguen fallando, la tarea queda failed', async () => {
  const { deps, calls } = fakeReviewDeps(REVIEW_MIXED, { runTests: async () => ({ ok: false, output: 'AssertionError boom' }) });
  const input = reviewInput({ attempts: 1 });
  await reviewTask(input, deps);
  assert.equal(calls.fix.length, 2);
  assert.deepEqual(calls.fix.map((f) => f.attempt), [2, 3]);
  assert.match(calls.fix[1].prompt, /AssertionError boom/);
  assert.equal(input.record.attempts, 3);
  assert.equal(input.record.status, 'failed');
  assert.equal(calls.review.length, 1);
  assert.ok(calls.commits.every((m) => m === 'orcatech: [T1] correcciones de revisión (tests fallando)'));
});

test('reviewTask: hallazgos high sin intentos restantes no llaman al reparador', async () => {
  const { deps, calls } = fakeReviewDeps(REVIEW_MIXED);
  const input = reviewInput({ attempts: 3 });
  await reviewTask(input, deps);
  assert.equal(input.record.review, REVIEW_MIXED);
  assert.equal(calls.fix.length, 0);
  assert.equal(input.record.attempts, 3);
  assert.equal(input.record.status, 'passed');
});

test('reviewTask: sin testCommand repara una vez sin correr tests; revisión inválida no rompe', async () => {
  const { deps, calls } = fakeReviewDeps(REVIEW_MIXED);
  const input = reviewInput({}, { testCommand: '' });
  await reviewTask(input, deps);
  assert.equal(calls.fix.length, 1);
  assert.equal(calls.tests, 0);
  assert.equal(calls.commits.length, 1);

  const invalid = fakeReviewDeps(undefined);
  const input2 = reviewInput();
  assert.equal(await reviewTask(input2, invalid.deps), undefined);
  assert.equal(input2.record.review, undefined);
  assert.equal(invalid.calls.fix.length, 0);
});
