#!/bin/sh
# orcatech installer
#   curl -fsSL https://raw.githubusercontent.com/masterfermin02/orcatech/main/install.sh | sh
#
# Environment overrides:
#   ORCATECH_DIR      where the source is installed   (default: ~/.local/share/orcatech)
#   ORCATECH_BIN_DIR  where the `orcatech` link goes  (default: ~/.local/bin)
#   ORCATECH_REPO     git URL to clone                (default: GitHub repo)
#   ORCATECH_REF      branch or tag to install        (default: main)
#
# Re-running the script updates an existing installation.

set -eu

# Everything lives in main() so a partially downloaded script never runs.
main() {
  REPO="${ORCATECH_REPO:-https://github.com/masterfermin02/orcatech.git}"
  REF="${ORCATECH_REF:-main}"
  DIR="${ORCATECH_DIR:-$HOME/.local/share/orcatech}"
  BIN_DIR="${ORCATECH_BIN_DIR:-$HOME/.local/bin}"

  if [ -t 1 ]; then
    bold=$(printf '\033[1m'); green=$(printf '\033[32m'); red=$(printf '\033[31m'); yellow=$(printf '\033[33m'); reset=$(printf '\033[0m')
  else
    bold=''; green=''; red=''; yellow=''; reset=''
  fi
  info() { printf '%s==>%s %s\n' "$bold" "$reset" "$*"; }
  warn() { printf '%swarning:%s %s\n' "$yellow" "$reset" "$*" >&2; }
  die()  { printf '%serror:%s %s\n' "$red" "$reset" "$*" >&2; exit 1; }

  # --- requirements ---------------------------------------------------------
  command -v git  >/dev/null 2>&1 || die "git is required. Install it and run this script again."
  command -v node >/dev/null 2>&1 || die "Node.js 22+ is required (https://nodejs.org)."
  command -v npm  >/dev/null 2>&1 || die "npm is required (it ships with Node.js)."

  node_major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$node_major" -ge 22 ] || die "Node.js 22+ is required; found $(node -v)."

  # --- fetch source ---------------------------------------------------------
  if [ -d "$DIR/.git" ]; then
    info "Updating orcatech in $DIR"
    git -C "$DIR" fetch --quiet --depth 1 origin "$REF"
    git -C "$DIR" checkout --quiet -B "$REF" FETCH_HEAD
  elif [ -e "$DIR" ]; then
    die "$DIR exists and is not an orcatech checkout. Remove it or set ORCATECH_DIR."
  else
    info "Downloading orcatech into $DIR"
    mkdir -p "$(dirname "$DIR")"
    git clone --quiet --depth 1 --branch "$REF" "$REPO" "$DIR"
  fi

  # --- dependencies ---------------------------------------------------------
  info "Installing dependencies"
  # tsx (a devDependency) runs the CLI, so dev dependencies are required.
  (cd "$DIR" && npm ci --include=dev --no-audit --no-fund --loglevel=error)

  # --- link the command -----------------------------------------------------
  mkdir -p "$BIN_DIR"
  chmod +x "$DIR/bin/orcatech.mjs"
  ln -sf "$DIR/bin/orcatech.mjs" "$BIN_DIR/orcatech"

  printf '\n%sorcatech installed%s → %s/orcatech\n' "$green" "$reset" "$BIN_DIR"

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      warn "$BIN_DIR is not in your PATH. Add this line to your shell profile (~/.zshrc, ~/.bashrc):"
      printf '\n    export PATH="%s:$PATH"\n\n' "$BIN_DIR"
      ;;
  esac

  printf 'Next: run %sorcatech accounts%s to check your agent CLIs and logins.\n' "$bold" "$reset"
}

main "$@"
