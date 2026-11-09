import { spawn } from 'node:child_process';

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Ejecuta un proceso con stdin cerrado; llama onLine por cada línea de stdout. */
export function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string | undefined>; signal?: AbortSignal; onLine?: (line: string) => void; timeoutMs?: number },
): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let buf = '';
    const kill = () => child.kill('SIGTERM');
    opts.signal?.addEventListener('abort', kill, { once: true });
    const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : undefined;
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      buf += s;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        opts.onLine?.(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => {
      stderr += String(e);
      resolve({ code: 127, stdout, stderr });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', kill);
      if (buf) opts.onLine?.(buf);
      resolve({ code, stdout, stderr });
    });
  });
}
