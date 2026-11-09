import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import type { RunRequest } from '../src/backends/types.ts';

// Aísla el almacenamiento global sin modificar HOME ni leer configuraciones personales.
const root = mkdtempSync(join(os.tmpdir(), 'orcatech-acceptance-'));
const tmpMock = mock.method(os, 'tmpdir', () => root);
const homeMock = mock.method(os, 'homedir', () => root);
syncBuiltinESMExports();
const { startRun, loadRun } = await import('../src/pipeline.ts');
const { backends } = await import('../src/backends/index.ts');
const { REVIEW_SCHEMA } = await import('../src/prompts.ts');
homeMock.mock.restore();
syncBuiltinESMExports();
after(() => { tmpMock.mock.restore(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); });

const git = (repo: string, ...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const goodReview = { verdict: 'approve', summary: 'OK', issues: [] };
const strong = "require('node:assert/strict').equal(require('../value.cjs'), 2);";
const weak = "require('node:assert/strict').ok(require('../value.cjs') >= 1);";

async function scenario(opts: { redGreen?: boolean; reviewEachTask?: boolean; noGit?: boolean; noCommand?: boolean; repairs?: boolean; max?: number; severity?: string } = {}) {
  const repo = mkdtempSync(join(root, 'repo-'));
  mkdirSync(join(repo, 'test'));
  writeFileSync(join(repo, 'value.cjs'), 'module.exports = 1;');
  writeFileSync(join(repo, 'orcatech.config.json'), JSON.stringify({
    redGreen: opts.redGreen ?? true, reviewEachTask: opts.reviewEachTask ?? true,
    maxFixAttempts: opts.max ?? 3, fixerLadder: ['codex', 'claude-personal:claude-opus-5-5'],
  }));
  if (!opts.noGit) {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'user.name', 'Acceptance');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
  }
  const calls: RunRequest[] = [];
  const run = async (_account: unknown, req: RunRequest) => {
    calls.push(req);
    let structured: unknown;
    if (req.role === 'planner') structured = {
      summary: 'Change value', risks: [], testCommand: opts.noCommand ? '' : 'node test/value.test.cjs',
      tasks: [{ id: 'T1', title: 'Value', kind: 'backend', description: 'Return 2', acceptance: ['value is 2'], files: ['value.cjs'] }],
    };
    if (req.role === 'coder') {
      writeFileSync(join(repo, 'value.cjs'), opts.repairs ? 'module.exports = 0;' : 'module.exports = 2;');
      writeFileSync(join(repo, 'test/value.test.cjs'), opts.repairs ? weak : strong);
    }
    if (req.role === 'fixer') {
      if (req.prompt.includes('FALLEN sin la implementación')) writeFileSync(join(repo, 'test/value.test.cjs'), strong);
      else if (req.prompt.includes('Hallazgos de severidad high')) writeFileSync(join(repo, 'review-fix.txt'), 'fixed');
      else writeFileSync(join(repo, 'value.cjs'), 'module.exports = 2;');
    }
    if (req.role === 'tester') structured = { passed: true, summary: 'OK', testCommand: '', criteria: [] };
    if (req.role === 'reviewer') {
      assert.deepEqual(req.schema, REVIEW_SCHEMA);
      structured = req.prompt.includes('Revisa SOLO') && opts.severity
        ? { verdict: 'changes', summary: 'Finding', issues: [{ severity: opts.severity, file: 'value.cjs', description: 'fix value' }] }
        : goodReview;
    }
    return { ok: true, text: 'fixture', structured };
  };
  const mocks = Object.values(backends).map((backend) => mock.method(backend, 'run', run));
  const dirs = () => readdirSync(os.tmpdir()).filter(n => n.startsWith('orcatech-red-')).sort();
  const before = dirs();
  try {
    const state = await startRun({ repo, idea: 'Return 2', autoApprove: true }).done;
    assert.equal(state.status, 'done', state.error ?? 'corrida completada');
    assert.deepEqual(loadRun(state.id), JSON.parse(JSON.stringify(state)), 'estado persistido completo');
    assert.deepEqual(dirs(), before, 'sin directorios temporales filtrados');
    if (!opts.noGit) assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1);
    return { state, calls };
  } finally {
    mocks.forEach(m => m.mock.restore());
  }
}

test('aceptación: pipeline real prueba RED y guarda revisión por tarea y final', async () => {
  const { state, calls } = await scenario();
  assert.equal(state.tasks.T1.proof?.status, 'proven');
  assert.deepEqual(state.tasks.T1.review, goodReview);
  assert.deepEqual(state.steps.filter(s => s.role === 'reviewer').map(s => s.title), ['Revisar [T1]', 'Revisión']);
  assert.equal(calls.filter(c => c.role === 'fixer').length, 0);
});

test('aceptación: reparaciones de tests, refuerzo y revisión comparten límite y escalera', async () => {
  const { state, calls } = await scenario({ repairs: true, severity: 'high' });
  assert.equal(state.tasks.T1.attempts, 3);
  assert.equal(state.tasks.T1.proof?.status, 'proven');
  assert.deepEqual(state.steps.filter(s => s.role === 'fixer').map(s => s.account), ['codex', 'claude-personal', 'claude-personal']);
  assert.deepEqual(calls.filter(c => c.role === 'fixer').map(c => c.model), [undefined, 'claude-opus-5-5', 'claude-opus-5-5']);
  assert.equal(state.steps.filter(s => s.title.startsWith('Reforzar tests')).length, 1);
  assert.equal(state.steps.filter(s => s.title.startsWith('Corregir revisión de')).length, 1);
  assert.ok(state.tasks.T1.commit);
});

test('aceptación: agotar intentos conserva not-red y no repara revisión high', async () => {
  const { state } = await scenario({ repairs: true, severity: 'high', max: 1 });
  assert.equal(state.tasks.T1.attempts, 1);
  assert.equal(state.tasks.T1.proof?.status, 'not-red');
  assert.equal(state.steps.filter(s => s.role === 'fixer').length, 1);
});

test('aceptación: flags, ausencia de git/comando y revisión final', async () => {
  for (const opts of [{ redGreen: false, reviewEachTask: false }, { noGit: true }, { noCommand: true }]) {
    const { state } = await scenario(opts);
    assert.equal(state.tasks.T1.proof?.status, 'skipped');
    assert.equal(state.steps.filter(s => s.title === 'Revisión').length, 1);
    if (opts.reviewEachTask === false || opts.noGit) assert.equal(state.steps.filter(s => s.title === 'Revisar [T1]').length, 0);
  }
});

test('aceptación: hallazgos medium/low no llaman al fixer', async () => {
  for (const severity of ['medium', 'low']) {
    const { state } = await scenario({ severity });
    assert.equal(state.tasks.T1.review?.issues[0].severity, severity);
    assert.equal(state.steps.filter(s => s.role === 'fixer').length, 0);
  }
});

test('aceptación: dashboard renderiza chips, escapa sus textos y acepta estados antiguos', async () => {
  const { state } = await scenario();
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const script = html.split('<script>')[1].split('</script>')[0];
  const prefix = script.slice(0, script.indexOf('async function loadConfig'));
  const render = script.slice(script.indexOf('const PROOF_ES'), script.indexOf("$('#new').addEventListener"));
  const target = { innerHTML: '', scrollTop: 0, scrollHeight: 0 };
  const context = { state, document: { querySelector: (s: string) => ['#detail', '#log'].includes(s) ? target : null, querySelectorAll: () => [] } };
  const evaluate = () => runInNewContext(prefix + render + '\ndetail = state; renderDetail();', { ...context });
  evaluate();
  assert.match(target.innerHTML, /red→green probado/);
  assert.match(target.innerHTML, /revisión: approve/);
  const payload = '<img src=x onerror="alert(1)">';
  state.tasks.T1.proof!.detail = payload;
  state.tasks.T1.review!.summary = payload;
  evaluate();
  assert.ok(target.innerHTML.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.ok(!target.innerHTML.includes(payload));
  delete state.tasks.T1.proof;
  delete state.tasks.T1.review;
  evaluate();
  assert.doesNotMatch(target.innerHTML, /red→green probado|revisión: approve/);
});

test('aceptación: error de copia de tests limpia un worktree ya creado', async () => {
  const { runRedCheck } = await import('../src/redgreen.ts');
  const repo = mkdtempSync(join(root, 'cleanup-'));
  const path = join(repo, 'test/value.test.cjs');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'old.txt'), 'old');
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Acceptance');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base con directorio');
  const preCommit = git(repo, 'rev-parse', 'HEAD');
  rmSync(path, { recursive: true });
  writeFileSync(path, strong);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'directorio reemplazado por test');
  const proof = await runRedCheck({ repo, preCommit, postCommit: git(repo, 'rev-parse', 'HEAD'), testCommand: 'true' });
  assert.equal(proof.status, 'inconclusive');
  assert.match(proof.detail, /EISDIR/);
  assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1);
  assert.deepEqual(readdirSync(root).filter(n => n.startsWith('orcatech-red-')), []);
});

test('aceptación: README documenta opciones, estados y crédito MIT', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const option of ['redGreen', 'reviewEachTask', 'fixerLadder']) assert.ok(readme.includes(option));
  for (const status of ['proven', 'not-red', 'inconclusive', 'no-tests', 'skipped']) assert.ok(readme.includes('"' + status + '"') || readme.includes('`' + status + '`'));
  assert.match(readme, /redGreen[\s\S]*?true.*?by default/);
  assert.match(readme, /reviewEachTask.*?true.*?by default/);
  assert.match(readme, /Without a ladder, every attempt uses the `fixer` role as configured/);
  assert.match(readme, /https:\/\/github.com\/ricardov03\/code-forge, MIT/);
});
