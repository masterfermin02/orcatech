# orcatech

Autonomous orchestrator for coding agents. You give it an idea; one agent **plans**, you **approve** (just once), and then
other agents **code, test, fix and review** on their own until they hand you a git branch ready for review.

Each role can be a different agent — **Claude** (personal or work account), **Codex** or **Gemini** — and you choose which:
in the config, per run (CLI or dashboard), or even per task before approving the plan.

```
idea ─► planner ─► [your approval] ─► for each task: coder ─► tests ─► fixer (up to N times) ─► commit
                                       ─► tester (acceptance) ─► reviewer ─► fixer (if serious findings) ─► report
```

## Installation

```bash
git clone https://github.com/masterfermin02/orcatech.git
cd orcatech && npm install
npm link            # makes the `orcatech` command available system-wide
orcatech accounts   # checks accounts and CLIs
```

Requirements: Node 22+, a logged-in Claude Code session (`~/.claude` and/or `~/.claude-work`), `codex` installed and logged in.
Gemini is optional: `npm i -g @google/gemini-cli`.

## Usage

```bash
# Inside the project repo (must be clean: no uncommitted changes)
cd ~/my-project
orcatech run "add a spectator mode with a free camera"

# Choose agents per role (account[:model])
orcatech run "endpoint to export appraisals to PDF" \
  --planner claude-work --coder codex --reviewer claude-work:claude-sonnet-5-5

# Everything on one account, fully autonomous (no approval pause)
orcatech run "fix the minimap lag" --all claude-personal -y

orcatech dashboard        # only the web dashboard at http://127.0.0.1:4317
orcatech runs             # history
orcatech show <id>        # report for a run
```

`orcatech run` also starts the dashboard. The plan can be approved in the terminal (`s`/`n`) or in the dashboard,
where you can also **change the agent for each task** or remove tasks before approving.

## Accounts, roles and routing

An **account** is a backend (`claude` | `codex` | `gemini`) with its own environment. These exist by default:

| Account           | Backend | How it is isolated                                |
| ----------------- | ------- | ------------------------------------------------- |
| `claude-personal` | claude  | removes `CLAUDE_CONFIG_DIR` → uses `~/.claude`    |
| `claude-work`     | claude  | `CLAUDE_CONFIG_DIR=~/.claude-work`                |
| `codex`           | codex   | `~/.codex` (for another account use `CODEX_HOME`) |
| `gemini`          | gemini  | `GEMINI_API_KEY` or the CLI login                 |

The **roles** are `planner`, `coder`, `tester`, `fixer` and `reviewer`. Configuration is merged in this order (last one wins):
defaults → `~/.orcatech/config.json` → `<repo>/orcatech.config.json` → run flags → per-task choice in the dashboard.

```jsonc
// orcatech.config.json  (created by `orcatech init`)
{
  "accounts": {
    "codex-work": { "backend": "codex", "env": { "CODEX_HOME": "~/.codex-work" } }
  },
  "roles": {
    "planner":  { "account": "claude-work", "model": "claude-opus-5-5", "effort": "high" },
    "coder":    { "account": "codex" },
    "reviewer": { "account": "claude-personal", "model": "claude-sonnet-5-5" }
  },
  // the planner tags each task with a type; here you decide who codes it
  "routing": { "game-render": "claude-personal", "backend": "codex", "frontend": "claude-work" },
  "maxFixAttempts": 3,
  "maxRunBudgetUsd": 25,
  "testCommand": "vendor/bin/pest"   // optional; auto-detected otherwise
}
```

Priority for choosing who codes a task: **dashboard choice > routing by type > `coder` role**.

## Project types

Detected automatically; they adjust the instructions and the test command:

- **Laravel + Inertia** (`artisan` + `composer.json`) → `vendor/bin/pest` or `php artisan test`
- **Browser games** (deps like phaser/three, or a README that talks about a game, `<canvas>`) → `npm test` + Playwright if present
- **Node / TS** → `npm run typecheck && npm test` · **Python** → `pytest`

## Safety

- Works on an `orcatech/<id>` branch with one commit per task; **never pushes or deploys** (blocked for Claude; Codex runs in `workspace-write`).
- Planner and reviewer are read-only. A clean repo is required before starting.
- The dashboard only listens on `127.0.0.1` and requires the `x-orcatech` header on POST requests.
- `maxRunBudgetUsd` stops the run if Claude's estimated spend exceeds it (Codex and Gemini only report tokens).

## Where everything is stored

`~/.orcatech/runs/<id>/` → `state.json`, `events.jsonl` (live log), `plan.json`, `report.md`.

## Development

```bash
npm run typecheck && npm test
```

## License

MIT — see [LICENSE](LICENSE).
