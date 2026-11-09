# orcatech

Autonomous orchestrator for coding agents. You give it an idea; one agent **plans**, you **approve** (just once), and then
other agents **code, test, fix and review** on their own until they hand you a git branch ready for review.

Each role can be a different agent — **Claude** (personal or work account), **Codex** or **Gemini** — and you choose which:
in the config, per run (CLI or dashboard), or even per task before approving the plan.

```
idea ─► planner ─► [your approval] ─► for each task:
          coder ─► tests ─► fixer (up to N times) ─► commit
            ─► red→green proof ─► fixer (strengthen tests, if not-red)
            ─► per-task review ─► fixer (if high findings) ─► tests ─► commit
        ─► tester (acceptance) ─► reviewer (whole branch) ─► fixer (if serious findings) ─► report
```

Every fixer call within a task shares the same `maxFixAttempts` budget, and the fixer can climb a
[ladder of agents](#per-task-review-and-fixer-ladder) as attempts go up.

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/masterfermin02/orcatech/main/install.sh | sh
orcatech accounts   # checks accounts and CLIs
```

The installer puts the source in `~/.local/share/orcatech` and links the `orcatech` command into `~/.local/bin`
(no sudo). Run it again to update. Override the locations with `ORCATECH_DIR` / `ORCATECH_BIN_DIR`, or pin a
version with `ORCATECH_REF=<tag>`. To uninstall: `rm -rf ~/.local/share/orcatech ~/.local/bin/orcatech`.

<details>
<summary>Manual install</summary>

```bash
git clone https://github.com/masterfermin02/orcatech.git
cd orcatech && npm install
npm link            # makes the `orcatech` command available system-wide
```
</details>

Requirements: Node 22+, git, a logged-in Claude Code session (`~/.claude` and/or `~/.claude-work`), `codex` installed and logged in.
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
  "testCommand": "vendor/bin/pest",  // optional; auto-detected otherwise
  "redGreen": true,                  // default true: prove each task's new tests fail without the change
  "reviewEachTask": true,            // default true: review each task's own diff and fix high findings
  "fixerLadder": ["claude-personal:claude-sonnet-5-5", "codex", "claude-work:claude-opus-5-5"]  // optional
}
```

Priority for choosing who codes a task: **dashboard choice > routing by type > `coder` role**.

## Red→green proof

A test that passes both with and without a change proves nothing. So after a task passes its tests and is committed,
orcatech checks that the task's tests actually **fail on the code from before the task** (`redGreen`, `true` by default):

1. It takes only the test files the task **added or changed** (`git diff <pre>..<post>`; deleted tests are ignored).
   Test files are recognized by path: `test/`, `tests/`, `__tests__/`, `spec/`, `*.test.*`, `*.spec.*`, `test_*.py`,
   `*_test.py`, `*_test.go`, `*Test.php`.
2. It creates a **temporary git worktree** at the commit before the task and copies in the post-task version of those tests.
   It never writes through symlinks: a test file that was a symlink in the previous commit is replaced by a regular
   file, and a path whose parent directory is a symlink makes the proof `inconclusive`.
3. Dependency folders from your repo (`node_modules`, `vendor`, `.venv`, `venv`) are **symlinked** into the worktree,
   so the tests don't fail just because dependencies aren't installed there. A Composer `vendor` is the exception:
   `vendor/composer`, `vendor/bin` and the top-level files are **copied** (only packages are symlinked), so the
   autoloader resolves your application classes inside the worktree, not from the main repo.
4. It runs the plan's test command in the worktree and expects it to fail.
5. The worktree, the symlinks and the temporary directory are **always removed**, even if something goes wrong.

Each task ends up with one of these proof states (shown in the report and the dashboard):

| State          | Meaning                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| `proven`       | The new/changed tests fail on the previous code (with a recognizable assertion/test failure) and pass with the task: they prove the change. |
| `not-red`      | The tests also pass on the previous code, so they don't prove the change.                                   |
| `inconclusive` | The run failed for another reason: a load, import or compile error (e.g. the test imports a module the task created), an environment error (command not found, exit 126/127, database/network connection, missing config), output with no recognizable test failure, a timeout, or a worktree error. |
| `no-tests`     | The task didn't add or change any test file (or produced no changes at all).                               |
| `skipped`      | The proof didn't run: `redGreen` is `false`, there is no git, no test command, or the task failed its tests. |

When the result is `not-red`, the fixer gets **one chance to strengthen the tests** so they fail without the change.
That attempt **counts toward `maxFixAttempts`** (if none are left, the task stays `not-red`). After strengthening,
the tests are run again and committed, and the proof is repeated against the same previous commit; if the stronger
tests no longer pass with the task, the task is marked `failed`. A `not-red` or `inconclusive` proof never fails a task
on its own — it's a signal for you when reviewing the branch.

## Per-task review and fixer ladder

**`reviewEachTask`** (`true` by default) runs the `reviewer` on **each task's own diff** (from the commit before the task
to the task's last commit) right after the red→green proof, using the same structured review format as the final review.
If there are **high** severity findings, they go to the fixer, then the tests are run again and the result is committed;
if the tests fail, the fixer retries with their output. All of this uses the attempts left in `maxFixAttempts` (shared
with test repairs and the red→green strengthening), and a task whose tests still fail is marked `failed`. There is a
single review pass per task (no re-review) to keep cost bounded. The **final whole-branch review** still runs at the end.
Set `reviewEachTask: false` to keep only the final review.

**`fixerLadder`** (optional) is a list of `account[:model]` specs that lets the fixer escalate. Attempt **N** of a task uses
`fixerLadder[min(N-1, len-1)]`, applied on top of the `fixer` role (the last rung is reused once you run out of rungs).
Without a ladder, every attempt uses the `fixer` role as configured. The final review fix uses the first rung. Every
account in the ladder must exist in `accounts`.

```jsonc
{
  "maxFixAttempts": 4,
  "fixerLadder": ["claude-personal:claude-sonnet-5-5", "codex", "claude-work:claude-opus-5-5"]
}
```

With this config, a task's 1st fix attempt uses Sonnet on `claude-personal`, the 2nd uses `codex`, and the 3rd and 4th
use Opus on `claude-work`. Each fixer step's title shows the rung it used, e.g. `(codex)`.

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

## Credits

The red→green proof and the per-task review with a fixer ladder:
Inspired by code-forge (https://github.com/ricardov03/code-forge, MIT).

## License

MIT — see [LICENSE](LICENSE).
