import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountEnv, extractJson } from '../src/backends/types.ts';
import { DEFAULT_CONFIG, ladderSpec, loadConfig, roleOverride } from '../src/config.ts';
import { detectProject } from '../src/detect.ts';
import { PLAN_SCHEMA, REVIEW_SCHEMA, TEST_SCHEMA } from '../src/prompts.ts';
import { classifyRedRun, isTestFile, newSourceFiles, pickTestFiles } from '../src/redgreen.ts';
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
