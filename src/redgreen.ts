// Prueba RED→GREEN por tarea (idea tomada de code-forge): los tests que agregó o
// cambió una tarea se corren sobre el código previo a la tarea y deberían fallar.
// La lógica pura va primero; runRedCheck (al final) hace el I/O con git y un
// worktree temporal que se limpia siempre.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { runProcess } from './backends/proc.ts';
import { addWorktree, changedFiles, removeWorktree, showFile } from './git.ts';

export type ProofStatus = 'proven' | 'not-red' | 'inconclusive' | 'no-tests' | 'skipped';

export interface TaskProof {
  status: ProofStatus;
  detail: string;
  testFiles: string[];
}

export interface FileChange {
  /** Estado de `git diff --name-status`: A, M, D, R100, C075, ... */
  status: string;
  /** Ruta (en renombres/copias, la ruta de destino). */
  path: string;
}

const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec']);

const TEST_NAME_PATTERNS: RegExp[] = [
  /\.(test|spec)\.[^/]+$/i, // foo.test.ts, foo.spec.js
  /^test_[^/]+\.py$/, // test_api.py
  /_test\.py$/, // api_test.py
  /_test\.go$/, // x_test.go
  /Test\.php$/, // UserTest.php
];

/** Heurística multi-lenguaje para reconocer archivos de test por su ruta. */
export function isTestFile(path: string): boolean {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return false;
  const name = parts[parts.length - 1];
  if (parts.slice(0, -1).some((dir) => TEST_DIRS.has(dir))) return true;
  return TEST_NAME_PATTERNS.some((re) => re.test(name));
}

const kind = (status: string) => status.trim().charAt(0).toUpperCase();

/** Tests agregados, modificados o destino de un renombre/copia (nunca los borrados). */
export function pickTestFiles(changes: FileChange[]): string[] {
  const out: string[] = [];
  for (const c of changes) {
    if (!['A', 'M', 'R', 'C'].includes(kind(c.status))) continue;
    if (isTestFile(c.path) && !out.includes(c.path)) out.push(c.path);
  }
  return out;
}

/** Archivos nuevos (A) de la tarea que no son tests. */
export function newSourceFiles(changes: FileChange[]): string[] {
  const out: string[] = [];
  for (const c of changes) {
    if (kind(c.status) === 'A' && !isTestFile(c.path) && !out.includes(c.path)) out.push(c.path);
  }
  return out;
}

/** Señales de que el test no llegó a ejecutarse (fallo de carga, import o compilación). */
const LOAD_ERROR_PATTERNS: RegExp[] = [
  /Cannot find module/i,
  /ERR_MODULE_NOT_FOUND/,
  /ERR_PACKAGE_PATH_NOT_EXPORTED/,
  /Cannot find package/i,
  /does not provide an export named/i,
  /SyntaxError/,
  /error TS\d+/,
  /ModuleNotFoundError/,
  /ImportError/,
  /Failed to resolve import/i,
  /Failed to load url/i,
  /Could not resolve/i,
  /Module not found/i,
  /Class "[^"]*" not found/,
  /PHP Parse error/i,
  /\[build failed\]/i, // go test
  /cannot find symbol/i, // java
  /error\[E\d+\]/, // rust
  /unresolved import/i, // rust
  /LoadError/, // ruby
  /uninitialized constant/i, // ruby
];

function basenameNoExt(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = name.indexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Clasifica la corrida de los tests nuevos sobre el código previo a la tarea.
 * code === null significa timeout o abortado.
 */
export function classifyRedRun(
  run: { code: number | null; output: string },
  ctx: { testFiles: string[]; newFiles: string[] },
): { status: 'proven' | 'not-red' | 'inconclusive'; detail: string } {
  const files = ctx.testFiles.length ? ctx.testFiles.join(', ') : 'los tests de la tarea';

  if (run.code === 0) {
    return {
      status: 'not-red',
      detail: `Los tests (${files}) pasan sobre el código previo a la tarea: no demuestran el cambio.`,
    };
  }
  if (run.code === null) {
    return {
      status: 'inconclusive',
      detail: 'La corrida sobre el código previo no terminó (timeout o abortada).',
    };
  }

  const output = run.output ?? '';
  const loadError = LOAD_ERROR_PATTERNS.find((re) => re.test(output));
  if (loadError) {
    const mentioned = ctx.newFiles.find((f) => {
      const base = basenameNoExt(f);
      return base.length > 0 && new RegExp(`(^|[^\\w-])${escapeRe(base)}(?![\\w-])`).test(output);
    });
    if (mentioned) {
      return {
        status: 'inconclusive',
        detail: `El test importa un módulo nuevo creado por la tarea (${mentioned}); falla al cargar sobre el código previo, no por una aserción.`,
      };
    }
    return {
      status: 'inconclusive',
      detail: 'Los tests fallan por un error de carga, import o compilación sobre el código previo, no por una aserción.',
    };
  }

  return {
    status: 'proven',
    detail: `Los tests (${files}) fallan sobre el código previo (código ${run.code}) y pasan con la tarea.`,
  };
}

/** Carpetas de dependencias (normalmente ignoradas por git) que se enlazan en el worktree. */
const DEP_DIRS = ['node_modules', 'vendor', '.venv', 'venv'];

export interface RedCheckOptions {
  repo: string;
  /** Commit previo a la tarea. */
  preCommit: string;
  /** Commit con la tarea aplicada. */
  postCommit: string;
  testCommand: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Corre los tests que agregó/cambió la tarea sobre el código previo a la tarea,
 * en un git worktree temporal. Nunca lanza: los errores dan 'inconclusive'.
 * El worktree y el directorio temporal se borran siempre.
 */
export async function runRedCheck(opts: RedCheckOptions): Promise<TaskProof> {
  let testFiles: string[] = [];
  let dir: string | undefined;
  const links: string[] = [];
  try {
    const changes = await changedFiles(opts.repo, opts.preCommit, opts.postCommit);
    testFiles = pickTestFiles(changes);
    if (testFiles.length === 0) {
      return { status: 'no-tests', detail: 'La tarea no agregó ni cambió archivos de test.', testFiles };
    }

    dir = await realpath(await mkdtemp(join(tmpdir(), 'orcatech-red-')));
    try {
      await addWorktree(opts.repo, dir, opts.preCommit);
    } catch (e) {
      return { status: 'inconclusive', detail: `No se pudo crear el worktree: ${errMsg(e)}`, testFiles };
    }

    // Tests en su versión post-tarea sobre el código previo.
    for (const file of testFiles) {
      const target = resolve(dir, file);
      const rel = relative(dir, target);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Ruta de test fuera del repo: ${file}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await showFile(opts.repo, opts.postCommit, file));
    }

    // Dependencias instaladas del repo principal, para no fallar solo por faltar.
    for (const dep of DEP_DIRS) {
      const src = join(opts.repo, dep);
      const dst = join(dir, dep);
      if (existsSync(src) && !existsSync(dst)) {
        await symlink(resolve(src), dst, 'dir');
        links.push(dst);
      }
    }

    const r = await runProcess('/bin/sh', ['-c', opts.testCommand], {
      cwd: dir,
      // NODE_TEST_CONTEXT es interno de node:test: si se hereda, un `node --test`
      // anidado reporta al padre y sale con 0 aunque fallen sus tests.
      env: { ...process.env, CI: '1', NODE_TEST_CONTEXT: undefined },
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 15 * 60_000,
    });
    const output = `${r.stdout}\n${r.stderr}`.trim();
    const verdict = classifyRedRun(
      { code: opts.signal?.aborted ? null : r.code, output },
      { testFiles, newFiles: newSourceFiles(changes) },
    );
    return { ...verdict, testFiles };
  } catch (e) {
    return { status: 'inconclusive', detail: `La prueba red→green falló: ${errMsg(e)}`, testFiles };
  } finally {
    // Primero los symlinks, para que ningún borrado recursivo siga el enlace.
    for (const l of links) await unlink(l).catch(() => undefined);
    if (dir) {
      // Aunque `worktree add` haya fallado, prune limpia cualquier registro a medias.
      await removeWorktree(opts.repo, dir);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
