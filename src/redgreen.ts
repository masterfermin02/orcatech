// Prueba RED→GREEN por tarea (idea tomada de code-forge): los tests que agregó o
// cambió una tarea se corren sobre el código previo a la tarea y deberían fallar.
// La lógica pura va primero; runRedCheck (al final) hace el I/O con git y un
// worktree temporal que se limpia siempre.

import { constants as fsConstants, existsSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

  if (run.code === 126 || run.code === 127 || INFRA_ERROR_PATTERNS.some((re) => re.test(output))) {
    return {
      status: 'inconclusive',
      detail: `La corrida sobre el código previo falló por un error de entorno o infraestructura (código ${run.code}), no por una aserción.`,
    };
  }

  if (ASSERTION_FAILURE_PATTERNS.some((re) => re.test(output))) {
    return {
      status: 'proven',
      detail: `Los tests (${files}) fallan sobre el código previo (código ${run.code}) y pasan con la tarea.`,
    };
  }

  return {
    status: 'inconclusive',
    detail: `La corrida sobre el código previo salió con código ${run.code} sin señales reconocibles de un fallo de aserción.`,
  };
}

/** Señales de que la corrida falló por el entorno (comando, red, base de datos, config), no por los tests. */
const INFRA_ERROR_PATTERNS: RegExp[] = [
  /command not found/i,
  /^\S*sh: (\d+: )?[^:\n]+: not found$/m, // sh/dash: "sh: 1: pytest: not found"
  /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN/,
  /Connection refused/i,
  /getaddrinfo/i,
  /could not connect to (the )?(server|database)/i,
  /SQLSTATE\[(HY000|08\d{3})\]/,
  /Access denied for user/i,
  /database "[^"]*" does not exist/i,
  /Unknown database/i,
  /Missing script:/i, // npm
  /ERR_PNPM_NO_SCRIPT/,
  /missing (required )?(environment|env) variable/i,
  /environment variable [^\n]* (is )?(not set|missing|required)/i,
  /No application encryption key/i, // Laravel sin APP_KEY
  /Could not open input file/i, // php
  /EADDRINUSE/,
];

/** Señales positivas de que los tests se ejecutaron y fallaron (aserciones o tests en rojo). */
const ASSERTION_FAILURE_PATTERNS: RegExp[] = [
  /AssertionError|ERR_ASSERTION|AssertionFailedError/,
  /^\s*not ok \d+/m, // TAP (node --test, prove)
  /^[#ℹ] fail [1-9]/m, // resumen de node --test
  /\b[1-9]\d* (failed|failing)\b/i, // jest/vitest/mocha/pytest
  /^FAILED\b|^=+ FAILURES =+|FAILED \(.*(failures|errors)=/m, // pytest/unittest
  /Failed asserting/i, // PHPUnit
  /^FAILURES!$/m, // PHPUnit
  /^\s*(✕|✗|×|✖)\s/m, // reporters con símbolos
  /^--- FAIL:|^FAIL\b/m, // go test, jest
  /assertion failed/i, // rust, C
  /test result: FAILED/, // cargo
  /^Failures:$/m, // rspec
  /\bexpected\b[^\n]*\b(to|but|got|received)\b/i,
  /Expected:?[^\n]*\n\s*(Received|Actual|but was|got)/i,
];

/** Carpetas de dependencias (normalmente ignoradas por git) que se enlazan en el worktree. */
const DEP_DIRS = ['node_modules', 'vendor', '.venv', 'venv'];

/** Dentro de un vendor de Composer, lo que se copia en vez de enlazarse (autoload y proxies de bin). */
const COMPOSER_LOCAL = new Set(['composer', 'bin']);

const isInside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const errCode = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;

/**
 * Escribe `content` en `root/file` sin salir de `root`: rechaza rutas con `..` y
 * directorios intermedios que sean symlinks; si el archivo final es un symlink,
 * lo sustituye por un archivo normal (nunca escribe a través del enlace).
 */
async function writeInside(root: string, file: string, content: string): Promise<void> {
  const target = resolve(root, file);
  if (target === root || !isInside(root, target)) throw new Error(`Ruta de test fuera del repo: ${file}`);
  const parts = relative(root, target).split(sep);
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    let st;
    try {
      st = await lstat(cur);
    } catch (e) {
      if (errCode(e) === 'ENOENT') break; // el resto no existe: mkdir crea directorios reales
      throw e;
    }
    if (!st.isSymbolicLink()) continue;
    if (i < parts.length - 1) throw new Error(`Ruta de test con un enlace simbólico en el commit previo: ${file}`);
    await unlink(cur);
  }
  await mkdir(dirname(target), { recursive: true });
  if (!isInside(root, await realpath(dirname(target)))) throw new Error(`Ruta de test fuera del repo: ${file}`);
  // O_NOFOLLOW: si alguien recreó el enlace entre medio, falla en vez de seguirlo.
  const fh = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o644);
  try {
    await fh.writeFile(content);
  } finally {
    await fh.close();
  }
}

/**
 * Pone a disposición del worktree las dependencias instaladas en el repo principal.
 * Normalmente es un symlink, salvo un vendor de Composer: su autoloader calcula la
 * raíz de la app desde vendor/composer (vía __DIR__, que resuelve symlinks), así
 * que vendor/composer, vendor/bin y los archivos sueltos se copian, y solo se
 * enlazan los paquetes. Los paquetes "path" que apuntan dentro del repo se
 * enlazan a su versión en el worktree.
 */
async function provideDependencies(repo: string, dir: string, links: string[]): Promise<void> {
  const repoReal = await realpath(repo);
  const link = async (target: string, at: string) => {
    await symlink(target, at, 'dir');
    links.push(at);
  };
  for (const dep of DEP_DIRS) {
    const src = join(repoReal, dep);
    const dst = join(dir, dep);
    if (!existsSync(src) || existsSync(dst)) continue;
    if (dep !== 'vendor' || !existsSync(join(src, 'composer'))) {
      await link(src, dst);
      continue;
    }
    const srcReal = await realpath(src);
    await mkdir(dst);
    for (const entry of await readdir(srcReal, { withFileTypes: true })) {
      const from = join(srcReal, entry.name);
      const to = join(dst, entry.name);
      if (COMPOSER_LOCAL.has(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) {
        await cp(from, to, { recursive: true, verbatimSymlinks: true });
        continue;
      }
      if (!entry.isDirectory()) {
        await link(from, to);
        continue;
      }
      // vendor/<namespace>/<paquete>
      await mkdir(to);
      for (const pkg of await readdir(from, { withFileTypes: true })) {
        const pkgFrom = join(from, pkg.name);
        let target = pkgFrom;
        if (pkg.isSymbolicLink()) {
          const real = await realpath(pkgFrom).catch(() => pkgFrom);
          if (isInside(repoReal, real) && !isInside(srcReal, real)) target = join(dir, relative(repoReal, real));
        }
        await link(target, join(to, pkg.name));
      }
    }
  }
}

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
      await writeInside(dir, file, await showFile(opts.repo, opts.postCommit, file));
    }

    // Dependencias instaladas del repo principal, para no fallar solo por faltar.
    await provideDependencies(opts.repo, dir, links);

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
