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
