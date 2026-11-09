# orcatech

Orquestador autónomo de agentes de programación. Le das una idea; un agente **planifica**, tú **apruebas** (una sola vez) y después
otros agentes **programan, testean, reparan y revisan** solos hasta entregarte una rama git lista para revisar.

Cada rol puede ser un agente distinto — **Claude** (cuenta personal o work), **Codex** o **Gemini** — y lo eliges tú:
en la config, por corrida (CLI o dashboard) o incluso por tarea antes de aprobar el plan.

```
idea ─► planner ─► [tu aprobación] ─► por cada tarea: coder ─► tests ─► fixer (hasta N veces) ─► commit
                                       ─► tester (aceptación) ─► reviewer ─► fixer (si hay hallazgos graves) ─► reporte
```

## Instalación

```bash
cd ~/orcatech && npm install
npm link            # deja el comando `orcatech` disponible en todo el sistema
orcatech accounts   # comprueba cuentas y CLIs
```

Requisitos: Node 22+, sesión iniciada en Claude Code (`~/.claude` y/o `~/.claude-work`), `codex` instalado y logueado.
Gemini es opcional: `npm i -g @google/gemini-cli`.

## Uso

```bash
# En el repo del proyecto (debe estar limpio: sin cambios sin commit)
cd ~/freefire
orcatech run "agregar modo espectador con cámara libre"

# Elegir agentes por rol (cuenta[:modelo])
orcatech run "endpoint para exportar tasaciones a PDF" \
  --planner claude-work --coder codex --reviewer claude-work:claude-sonnet-5-5

# Todo con una misma cuenta, totalmente autónomo (sin pausa de aprobación)
orcatech run "arreglar el lag del minimapa" --all claude-personal -y

orcatech dashboard        # solo el dashboard web en http://127.0.0.1:4317
orcatech runs             # historial
orcatech show <id>        # reporte de una corrida
```

`orcatech run` también levanta el dashboard. El plan se puede aprobar en la terminal (`s`/`n`) o en el dashboard,
donde además puedes **cambiar el agente de cada tarea** o quitar tareas antes de aprobar.

## Cuentas, roles y routing

Una **cuenta** es un backend (`claude` | `codex` | `gemini`) con su propio entorno. Por defecto existen:

| Cuenta            | Backend | Cómo se separa                                 |
| ----------------- | ------- | ---------------------------------------------- |
| `claude-personal` | claude  | quita `CLAUDE_CONFIG_DIR` → usa `~/.claude`    |
| `claude-work`     | claude  | `CLAUDE_CONFIG_DIR=~/.claude-work`             |
| `codex`           | codex   | `~/.codex` (para otra cuenta usa `CODEX_HOME`) |
| `gemini`          | gemini  | `GEMINI_API_KEY` o el login de la CLI          |

Los **roles** son `planner`, `coder`, `tester`, `fixer` y `reviewer`. La configuración se mezcla en este orden (gana el último):
defaults → `~/.orcatech/config.json` → `<repo>/orcatech.config.json` → flags de la corrida → elección por tarea en el dashboard.

```jsonc
// orcatech.config.json  (orcatech init lo crea)
{
  "accounts": {
    "codex-work": { "backend": "codex", "env": { "CODEX_HOME": "~/.codex-work" } }
  },
  "roles": {
    "planner":  { "account": "claude-work", "model": "claude-opus-5-5", "effort": "high" },
    "coder":    { "account": "codex" },
    "reviewer": { "account": "claude-personal", "model": "claude-sonnet-5-5" }
  },
  // el planner etiqueta cada tarea con un tipo; aquí decides quién la programa
  "routing": { "game-render": "claude-personal", "backend": "codex", "frontend": "claude-work" },
  "maxFixAttempts": 3,
  "maxRunBudgetUsd": 25,
  "testCommand": "vendor/bin/pest"   // opcional; si no, se detecta
}
```

Prioridad para programar una tarea: **elección en el dashboard > routing por tipo > rol `coder`**.

## Tipos de proyecto

Se detectan solos y ajustan las instrucciones y el comando de tests:

- **Laravel + Inertia** (`artisan` + `composer.json`) → `vendor/bin/pest` o `php artisan test`
- **Juegos de navegador** (deps como phaser/three o README que habla de juego, `<canvas>`) → `npm test` + Playwright si existe
- **Node / TS** → `npm run typecheck && npm test` · **Python** → `pytest`

## Seguridad

- Trabaja en una rama `orcatech/<id>` con un commit por tarea; **nunca hace push ni deploy** (bloqueado en Claude; Codex corre en `workspace-write`).
- Planner y reviewer son de solo lectura. Exige un repo limpio antes de empezar.
- El dashboard solo escucha en `127.0.0.1` y exige la cabecera `x-orcatech` en los POST.
- `maxRunBudgetUsd` corta la corrida si el gasto estimado de Claude lo supera (Codex y Gemini solo reportan tokens).

## Dónde queda todo

`~/.orcatech/runs/<id>/` → `state.json`, `events.jsonl` (log en vivo), `plan.json`, `report.md`.

## Desarrollo

```bash
npm run typecheck && npm test
```
