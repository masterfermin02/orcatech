import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, roleOverride, ROLES, type Role, type RoleConfig } from './config.ts';
import { cancel, decide, isActive, startRun } from './pipeline.ts';
import type { Plan } from './prompts.ts';
import { bus, listRuns, loadRun, readEvents, type RunEvent, type RunState } from './store.ts';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw new Error('cuerpo demasiado grande');
  }
  return raw ? JSON.parse(raw) : {};
}

/** Convierte { coder: "codex", reviewer: "claude-work:claude-sonnet-5-5" } en RoleConfig completos. */
export function resolveRoleSpecs(repo: string, specs: Partial<Record<Role, string>> = {}): Partial<Record<Role, RoleConfig>> {
  const cfg = loadConfig(repo);
  const out: Partial<Record<Role, RoleConfig>> = {};
  for (const role of ROLES) {
    const spec = specs[role]?.trim();
    if (spec) out[role] = roleOverride(cfg.roles[role], spec, cfg.accounts);
  }
  return out;
}

export function startServer(port: number, defaultRepo: string) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      // Una cabecera propia obliga a un preflight CORS: otras webs no pueden lanzar corridas contra localhost.
      if (req.method !== 'GET' && req.headers['x-orcatech'] !== '1') return send(res, 403, { error: 'Falta la cabecera x-orcatech' });
      if (req.method === 'GET' && (url.pathname === '/'|| url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(readFileSync(join(PUBLIC, 'index.html')));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/config') {
        const repo = resolve(url.searchParams.get('repo') || defaultRepo);
        const cfg = loadConfig(existsSync(repo) ? repo : defaultRepo);
        return send(res, 200, {
          defaultRepo,
          accounts: Object.entries(cfg.accounts).map(([name, a]) => ({ name, backend: a.backend, description: a.description ?? '' })),
          roles: cfg.roles,
          routing: cfg.routing,
          maxRunBudgetUsd: cfg.maxRunBudgetUsd,
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': ok\n\n');
        const onEvent = (e: RunEvent) => res.write(`event: log\ndata: ${JSON.stringify(e)}\n\n`);
        const onState = (s: RunState) => res.write(`event: state\ndata: ${JSON.stringify({ ...s, active: isActive(s.id) })}\n\n`);
        const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
        bus.on('event', onEvent);
        bus.on('state', onState);
        req.on('close', () => {
          clearInterval(ping);
          bus.off('event', onEvent);
          bus.off('state', onState);
        });
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'runs') {
        const id = parts[2];
        if (req.method === 'GET' && !id) return send(res, 200, listRuns().map((r) => ({ ...r, active: isActive(r.id) })));

        if (req.method === 'POST' && !id) {
          const b = await body(req);
          const idea = String(b.idea ?? '').trim();
          const repo = resolve(String(b.repo || defaultRepo));
          if (!idea) return send(res, 400, { error: 'Falta la idea' });
          if (!existsSync(repo) || !statSync(repo).isDirectory()) return send(res, 400, { error: `No existe la carpeta ${repo}` });
          const { id: runId } = startRun({ idea, repo, roles: resolveRoleSpecs(repo, b.roles), autoApprove: !!b.autoApprove });
          return send(res, 201, { id: runId });
        }

        if (id) {
          const run = loadRun(id);
          if (!run) return send(res, 404, { error: 'No existe la corrida' });
          if (req.method === 'GET' && !parts[3]) return send(res, 200, { ...run, active: isActive(id), events: readEvents(id) });
          if (req.method === 'POST' && parts[3] === 'approve') {
            const b = await body(req);
            return send(res, decide(id, true, b.plan as Plan | undefined) ? 200 : 409, { ok: true });
          }
          if (req.method === 'POST' && parts[3] === 'reject') return send(res, decide(id, false) ? 200 : 409, { ok: true });
          if (req.method === 'POST' && parts[3] === 'cancel') return send(res, cancel(id) ? 200 : 409, { ok: true });
        }
      }
      send(res, 404, { error: 'No encontrado' });
    } catch (e) {
      send(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  // Solo localhost: el dashboard puede lanzar agentes que escriben en disco.
  server.listen(port, '127.0.0.1');
  return server;
}
