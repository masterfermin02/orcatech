import { runProcess } from './backends/proc.ts';

async function git(repo: string, args: string[]) {
  const r = await runProcess('git', args, { cwd: repo });
  return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

export async function isGitRepo(repo: string): Promise<boolean> {
  return (await git(repo, ['rev-parse', '--is-inside-work-tree'])).out === 'true';
}

export async function isDirty(repo: string): Promise<boolean> {
  return (await git(repo, ['status', '--porcelain'])).out.length > 0;
}

/** Crea y cambia a la rama de trabajo; devuelve el commit base. */
export async function startBranch(repo: string, branch: string): Promise<string> {
  const head = await git(repo, ['rev-parse', 'HEAD']);
  if (!head.ok) {
    // Repo sin commits: crea uno vacío para tener una base con la cual comparar.
    await git(repo, ['commit', '--allow-empty', '-m', 'orcatech: base']);
  }
  const base = (await git(repo, ['rev-parse', 'HEAD'])).out;
  const co = await git(repo, ['checkout', '-b', branch]);
  if (!co.ok) throw new Error(`No se pudo crear la rama ${branch}: ${co.err}`);
  return base;
}

export async function commitAll(repo: string, message: string): Promise<string | undefined> {
  await git(repo, ['add', '-A']);
  if (!(await isDirty(repo))) return undefined;
  const c = await git(repo, ['commit', '-m', message, '--no-verify']);
  if (!c.ok) throw new Error(`git commit falló: ${c.err}`);
  return (await git(repo, ['rev-parse', '--short', 'HEAD'])).out;
}

export async function diffSince(repo: string, base: string, maxChars = 60_000): Promise<string> {
  const d = await git(repo, ['diff', `${base}...HEAD`, '--stat', '--patch']);
  return d.out.length > maxChars ? d.out.slice(0, maxChars) + '\n…(diff recortado)…' : d.out;
}

/** Hash completo de HEAD. */
export async function headCommit(repo: string): Promise<string> {
  const r = await git(repo, ['rev-parse', 'HEAD']);
  if (!r.ok) throw new Error(`git rev-parse HEAD falló: ${r.err}`);
  return r.out;
}

export interface ChangedFile {
  /** Letra de estado: A, M, D, R, C, T... (sin el porcentaje de similitud). */
  status: string;
  /** Ruta; en renombres/copias, la de destino. */
  path: string;
}

/** Parsea la salida de `git diff --name-status -z` (campos separados por NUL). */
export function parseNameStatusZ(out: string): ChangedFile[] {
  const fields = out.split('\0');
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < fields.length) {
    const raw = fields[i++];
    if (!raw) continue;
    const status = raw.charAt(0).toUpperCase();
    // Renombres y copias traen dos rutas (origen, destino); el resto, una.
    if (status === 'R' || status === 'C') {
      i++; // origen
      const dest = fields[i++];
      if (dest) files.push({ status, path: dest });
    } else {
      const path = fields[i++];
      if (path) files.push({ status, path });
    }
  }
  return files;
}

/** Archivos cambiados entre dos commits (`git diff --name-status -M from to`). */
export async function changedFiles(repo: string, from: string, to: string): Promise<ChangedFile[]> {
  const r = await runProcess('git', ['diff', '--name-status', '-M', '-z', from, to], { cwd: repo });
  if (r.code !== 0) throw new Error(`git diff --name-status falló: ${r.stderr.trim()}`);
  return parseNameStatusZ(r.stdout);
}

/** Como diffSince, pero para un rango concreto `from..to`. */
export async function diffRange(repo: string, from: string, to: string, maxChars = 60_000): Promise<string> {
  const d = await git(repo, ['diff', `${from}..${to}`, '--stat', '--patch']);
  return d.out.length > maxChars ? d.out.slice(0, maxChars) + '\n…(diff recortado)…' : d.out;
}

/** Contenido de `ref:path` (sin recortar espacios ni saltos de línea). */
export async function showFile(repo: string, ref: string, path: string): Promise<string> {
  const r = await runProcess('git', ['show', `${ref}:${path}`], { cwd: repo });
  if (r.code !== 0) throw new Error(`git show ${ref}:${path} falló: ${r.stderr.trim()}`);
  return r.stdout;
}

/** `git worktree add --detach <dir> <ref>`; lanza si falla. */
export async function addWorktree(repo: string, dir: string, ref: string): Promise<void> {
  const r = await git(repo, ['worktree', 'add', '--detach', dir, ref]);
  if (!r.ok) throw new Error(`git worktree add falló: ${r.err || r.out}`);
}

/** `git worktree remove --force <dir>` y luego `git worktree prune`. Nunca lanza. */
export async function removeWorktree(repo: string, dir: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', dir]).catch(() => undefined);
  await git(repo, ['worktree', 'prune']).catch(() => undefined);
}
