import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { accountEnv, extractJson } from '../src/backends/types.ts';
import { DEFAULT_CONFIG, ladderSpec, loadConfig, roleOverride } from '../src/config.ts';
import { detectProject } from '../src/detect.ts';
import { PLAN_SCHEMA, REVIEW_SCHEMA, TEST_SCHEMA } from '../src/prompts.ts';
import { changedFiles, diffRange, headCommit, showFile } from '../src/git.ts';
import { classifyRedRun, isTestFile, newSourceFiles, pickTestFiles, runRedCheck } from '../src/redgreen.ts';
import type { RunState } from '../src/store.ts';

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

test('RunState acepta el resultado de la prueba red→green por tarea', () => {
  const tasks: RunState['tasks'] = {
    T1: { status: 'passed', attempts: 1, account: 'codex', proof: { status: 'proven', detail: 'ok', testFiles: ['test/a.test.ts'] } },
    T2: { status: 'passed', attempts: 1, account: 'codex' },
  };
  assert.equal(tasks.T1.proof?.status, 'proven');
  assert.equal(tasks.T2.proof, undefined);
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

  // Commit previo inválido: worktree add falla → inconclusive, sin lanzar.
  const bad = await redCheck(repo, '0'.repeat(40), post, 'true');
  assert.equal(bad.status, 'inconclusive');
  assert.ok(bad.detail.length > 0);
});
