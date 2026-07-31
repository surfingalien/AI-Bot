#!/usr/bin/env bash
#
# Install SurfingAlien as a managed background service.
#
#   sudo ./install.sh                 system-wide, systemd, dedicated user
#        ./install.sh                 per-user (systemd --user, or launchd on macOS)
#        ./install.sh --uninstall     remove the service; keeps data unless --purge
#
# Re-running upgrades an existing install in place: the code is replaced, the
# .env and the brains under DATA_DIR are left alone.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/proxy"
PACKAGING="$SCRIPT_DIR/packaging"
LABEL="com.surfingalien.proxy"
UNIT="surfingalien"

# ---------------------------------------------------------------- output ----
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; CYN=$'\033[36m'; RST=$'\033[0m'
else
  B=""; DIM=""; GRN=""; YLW=""; RED=""; CYN=""; RST=""
fi
step() { printf '%s==>%s %s\n' "$CYN" "$RST" "$1"; }
ok()   { printf '%s ok %s %s\n' "$GRN" "$RST" "$1"; }
warn() { printf '%swarn%s %s\n' "$YLW" "$RST" "$1"; }
die()  { printf '%sfail%s %s\n' "$RED" "$RST" "$1" >&2; exit 1; }

usage() {
  cat <<EOF
${B}install.sh${RST} — install SurfingAlien as a service

  --prefix <dir>       where the code goes
  --data-dir <dir>     where brains and users.json live
  --port <n>           listen port (default 8787)
  --auth <mode>        open | token | session   (default session)
  --admin <name>       provision the first admin user (session mode)
  --admin-password-file <f>
                       read that admin's password from a file instead of prompting
  --service-user <u>   run as this user (system installs; default surfingalien)
  --no-service         install the files and CLI, skip the service manager
  --no-start           install the service but do not start it
  --uninstall          stop and remove the service
  --purge              with --uninstall, also delete DATA_DIR
  --yes                do not prompt
  -h, --help           this text

Defaults are chosen from whether you are root:
  root      prefix /opt/surfingalien       data /var/lib/surfingalien
  non-root  prefix ~/.local/share/surfingalien   data <prefix>/data
EOF
}

# -------------------------------------------------------------- defaults ----
IS_ROOT=0
[ "$(id -u)" -eq 0 ] && IS_ROOT=1

if [ "$IS_ROOT" -eq 1 ]; then
  PREFIX="/opt/surfingalien"
  DATA_DIR="/var/lib/surfingalien"
  SERVICE_USER="surfingalien"
  BIN_DIR="/usr/local/bin"
  LOG_DIR="/var/log"
else
  PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/surfingalien"
  DATA_DIR=""
  SERVICE_USER="$(id -un)"
  BIN_DIR="$HOME/.local/bin"
  LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/surfingalien"
fi

PORT="8787"
AUTH="session"
ADMIN_USER=""
ADMIN_PASS_FILE=""
DO_SERVICE=1
DO_START=1
UNINSTALL=0
PURGE=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)       PREFIX="$2"; shift 2 ;;
    --data-dir)     DATA_DIR="$2"; shift 2 ;;
    --port)         PORT="$2"; shift 2 ;;
    --auth)         AUTH="$2"; shift 2 ;;
    --admin)        ADMIN_USER="$2"; shift 2 ;;
    --admin-password-file) ADMIN_PASS_FILE="$2"; shift 2 ;;
    --service-user) SERVICE_USER="$2"; shift 2 ;;
    --no-service)   DO_SERVICE=0; shift ;;
    --no-start)     DO_START=0; shift ;;
    --uninstall)    UNINSTALL=1; shift ;;
    --purge)        PURGE=1; shift ;;
    --yes|-y)       ASSUME_YES=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "unknown option: $1 (try --help)" ;;
  esac
done

# An empty --prefix or --data-dir would turn the rm -rf calls below into
# deletions of /src, /bin or /. Refuse before anything is touched.
[ -n "$PREFIX" ] || die "--prefix cannot be empty"
case "$PREFIX" in /) die "--prefix cannot be /" ;; esac

[ -n "$DATA_DIR" ] || DATA_DIR="$PREFIX/data"
case "$DATA_DIR" in /) die "--data-dir cannot be /" ;; esac
ENV_FILE="$PREFIX/.env"

case "$AUTH" in open|token|session) ;; *) die "--auth must be open, token or session" ;; esac

# ------------------------------------------------- service manager choice ----
OS="$(uname -s)"
MANAGER="none"
if [ "$DO_SERVICE" -eq 1 ]; then
  if [ "$OS" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
    MANAGER="launchd"
  elif command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    MANAGER="systemd"
  else
    [ "$UNINSTALL" -eq 0 ] && warn "no supported service manager found — installing files only"
    DO_SERVICE=0
  fi
fi

SYSTEMD_SCOPE="system"
[ "$IS_ROOT" -eq 0 ] && SYSTEMD_SCOPE="user"
sysctl_cmd() { if [ "$SYSTEMD_SCOPE" = "user" ]; then systemctl --user "$@"; else systemctl "$@"; fi; }

if [ "$MANAGER" = "systemd" ] && [ "$SYSTEMD_SCOPE" = "user" ]; then
  UNIT_PATH="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT.service"
else
  UNIT_PATH="/etc/systemd/system/$UNIT.service"
fi
if [ "$IS_ROOT" -eq 1 ]; then
  PLIST_PATH="/Library/LaunchDaemons/$LABEL.plist"
else
  PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
fi

# ------------------------------------------------------------- uninstall ----
if [ "$UNINSTALL" -eq 1 ]; then
  step "Removing the SurfingAlien service"

  if command -v systemctl >/dev/null 2>&1 && [ -f "$UNIT_PATH" ]; then
    sysctl_cmd stop "$UNIT" 2>/dev/null || true
    sysctl_cmd disable "$UNIT" 2>/dev/null || true
    rm -f "$UNIT_PATH"
    sysctl_cmd daemon-reload 2>/dev/null || true
    ok "removed $UNIT_PATH"
  fi
  if command -v launchctl >/dev/null 2>&1 && [ -f "$PLIST_PATH" ]; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    ok "removed $PLIST_PATH"
  fi

  if [ -L "$BIN_DIR/surfingalien" ] || [ -f "$BIN_DIR/surfingalien" ]; then
    rm -f "$BIN_DIR/surfingalien"
    ok "removed $BIN_DIR/surfingalien"
  fi
  if [ -d "$PREFIX" ]; then
    rm -rf "$PREFIX"
    ok "removed $PREFIX"
  fi

  if [ "$PURGE" -eq 1 ]; then
    if [ -d "$DATA_DIR" ]; then
      rm -rf "$DATA_DIR"
      ok "purged $DATA_DIR"
    fi
  elif [ -d "$DATA_DIR" ]; then
    warn "kept your data at $DATA_DIR (pass --purge to delete it)"
  fi

  printf '\n%sUninstalled.%s\n\n' "$B" "$RST"
  exit 0
fi

# ------------------------------------------------------------- preflight ----
step "Preflight"

[ -d "$SRC" ] || die "cannot find $SRC — run this from a checkout of the repo"
[ -f "$SRC/server.js" ] || die "$SRC/server.js is missing"

command -v node >/dev/null 2>&1 || die "node is not installed (18 or newer required)"
NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node $("$NODE_BIN" -v) is too old — 18 or newer is required (global fetch)"
ok "node $("$NODE_BIN" -v) at $NODE_BIN"

command -v npm >/dev/null 2>&1 || die "npm is not installed"
ok "npm $(npm -v)"

if [ "$MANAGER" != "none" ]; then
  ok "service manager: $MANAGER${MANAGER:+ }${DIM}($SYSTEMD_SCOPE scope)${RST}"
fi

UPGRADE=0
[ -f "$PREFIX/server.js" ] && UPGRADE=1
[ "$UPGRADE" -eq 1 ] && ok "existing install at $PREFIX — upgrading in place"

printf '\n  %sprefix%s    %s\n' "$B" "$RST" "$PREFIX"
printf '  %sdata%s      %s\n'   "$B" "$RST" "$DATA_DIR"
printf '  %sport%s      %s\n'   "$B" "$RST" "$PORT"
printf '  %sauth%s      %s\n'   "$B" "$RST" "$AUTH"
[ "$IS_ROOT" -eq 1 ] && printf '  %srun as%s    %s\n' "$B" "$RST" "$SERVICE_USER"
printf '\n'

if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
  printf 'Continue? [Y/n] '
  read -r reply
  case "$reply" in [nN]*) echo "Aborted."; exit 1 ;; esac
  printf '\n'
fi

# ---------------------------------------------------------- service user ----
if [ "$IS_ROOT" -eq 1 ] && [ "$MANAGER" = "systemd" ]; then
  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    ok "service user $SERVICE_USER exists"
  else
    step "Creating service user $SERVICE_USER"
    if command -v useradd >/dev/null 2>&1; then
      useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
        || useradd --system --no-create-home --shell /sbin/nologin "$SERVICE_USER"
    elif command -v adduser >/dev/null 2>&1; then
      adduser --system --no-create-home --disabled-login "$SERVICE_USER"
    else
      die "no useradd/adduser available — pass --service-user with an existing account"
    fi
    ok "created $SERVICE_USER"
  fi
fi

# ------------------------------------------------------------ copy files ----
step "Installing to $PREFIX"
mkdir -p "$PREFIX"
# Replace code, never touch .env, data/ or node_modules ownership.
# ${PREFIX:?} so an empty PREFIX aborts instead of expanding to /src and /bin.
rm -rf "${PREFIX:?}/src" "${PREFIX:?}/bin"
cp -R "$SRC/src" "$SRC/bin" "$PREFIX/"
cp "$SRC/server.js" "$SRC/package.json" "$PREFIX/"
[ -f "$SRC/package-lock.json" ] && cp "$SRC/package-lock.json" "$PREFIX/"
[ -f "$SRC/users.example.json" ] && cp "$SRC/users.example.json" "$PREFIX/"
[ -f "$SRC/.env.example" ] && cp "$SRC/.env.example" "$PREFIX/"
chmod +x "$PREFIX/bin/surfingalien.js"
ok "code installed"

step "Installing production dependencies"
( cd "$PREFIX" && if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi ) >/dev/null 2>&1 \
  || die "dependency install failed — run 'cd $PREFIX && npm ci --omit=dev' to see why"
ok "dependencies installed"

# --------------------------------------------------------------- config -----
mkdir -p "$DATA_DIR"

if [ -f "$ENV_FILE" ]; then
  ok "keeping existing $ENV_FILE"
else
  step "Generating configuration"
  # The explicit flags carry everything; an env prefix here would be read by
  # the parent shell before it applied, which is exactly the confusion SC2097
  # warns about.
  "$NODE_BIN" "$PREFIX/bin/surfingalien.js" init \
    --auth "$AUTH" --data-dir "$DATA_DIR" --port "$PORT" --config "$ENV_FILE"
fi

# --------------------------------------------------------- first admin -----
# Session mode with zero users is not "locked": the server falls back to the
# shared anon tenant, so the box is wide open until somebody exists. Close that
# here rather than leaving it to the reader.
USER_COUNT="$("$NODE_BIN" "$PREFIX/bin/surfingalien.js" user list --data-dir "$DATA_DIR" --config "$ENV_FILE" --json 2>/dev/null | grep -c '"user"' || true)"

if [ "$AUTH" = "session" ] && [ "${USER_COUNT:-0}" -eq 0 ]; then
  if [ -n "$ADMIN_USER" ]; then
    step "Provisioning admin $ADMIN_USER"
    if [ -n "$ADMIN_PASS_FILE" ]; then
      "$NODE_BIN" "$PREFIX/bin/surfingalien.js" user add "$ADMIN_USER" --role admin \
        --password-file "$ADMIN_PASS_FILE" --data-dir "$DATA_DIR" --config "$ENV_FILE"
    elif [ -t 0 ]; then
      "$NODE_BIN" "$PREFIX/bin/surfingalien.js" user add "$ADMIN_USER" --role admin \
        --data-dir "$DATA_DIR" --config "$ENV_FILE"
    else
      die "--admin needs --admin-password-file when stdin is not a terminal"
    fi
  else
    warn "session mode has no users yet — until you add one the server accepts"
    warn "everyone as the shared 'anon' tenant. Fix it before exposing the port:"
    printf '         surfingalien user add <name> --role admin\n'
  fi
fi

if [ "$IS_ROOT" -eq 1 ] && [ "$MANAGER" = "systemd" ]; then
  chown -R "$SERVICE_USER" "$DATA_DIR"
  chown "$SERVICE_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "data and config owned by $SERVICE_USER"
fi

# ------------------------------------------------------------ CLI on PATH ---
mkdir -p "$BIN_DIR"
ln -sf "$PREFIX/bin/surfingalien.js" "$BIN_DIR/surfingalien"
ok "CLI linked at $BIN_DIR/surfingalien"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH — add it to use the 'surfingalien' command" ;;
esac

# -------------------------------------------------------------- service -----
render() {
  sed -e "s|__NODE__|$NODE_BIN|g" \
      -e "s|__PREFIX__|$PREFIX|g" \
      -e "s|__DATA_DIR__|$DATA_DIR|g" \
      -e "s|__ENV_FILE__|$ENV_FILE|g" \
      -e "s|__LOG_DIR__|$LOG_DIR|g" \
      "$1"
}

if [ "$MANAGER" = "systemd" ]; then
  step "Installing systemd unit ($SYSTEMD_SCOPE)"
  mkdir -p "$(dirname "$UNIT_PATH")"

  # A --user unit cannot set User=/Group=; a system unit must.
  if [ "$SYSTEMD_SCOPE" = "system" ]; then
    USER_DIRECTIVES="User=$SERVICE_USER"
  else
    USER_DIRECTIVES="# running in the calling user's own systemd scope"
  fi

  render "$PACKAGING/surfingalien.service" \
    | sed -e "s|__USER_DIRECTIVES__|$USER_DIRECTIVES|" > "$UNIT_PATH"
  ok "wrote $UNIT_PATH"

  sysctl_cmd daemon-reload
  sysctl_cmd enable "$UNIT" >/dev/null 2>&1 || true
  ok "enabled at boot"

  if [ "$DO_START" -eq 1 ]; then
    sysctl_cmd restart "$UNIT"
    ok "service started"
  fi

elif [ "$MANAGER" = "launchd" ]; then
  step "Installing launchd job"
  mkdir -p "$(dirname "$PLIST_PATH")" "$LOG_DIR"
  render "$PACKAGING/$LABEL.plist" > "$PLIST_PATH"
  ok "wrote $PLIST_PATH"
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  if [ "$DO_START" -eq 1 ]; then
    launchctl load -w "$PLIST_PATH"
    ok "service loaded"
  fi
fi

# --------------------------------------------------------------- verify -----
if [ "$DO_SERVICE" -eq 1 ] && [ "$DO_START" -eq 1 ]; then
  step "Waiting for the service to answer"
  HEALTHY=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
    sleep 1
  done
  if [ "$HEALTHY" -eq 1 ]; then
    ok "healthy on http://127.0.0.1:$PORT"
  else
    warn "no answer on port $PORT yet"
    if [ "$MANAGER" = "systemd" ]; then
      echo "  logs:  $(if [ "$SYSTEMD_SCOPE" = user ]; then echo 'journalctl --user'; else echo journalctl; fi) -u $UNIT -n 50"
    else
      echo "  logs:  tail -n 50 $LOG_DIR/surfingalien.err.log"
    fi
  fi
fi

# --------------------------------------------------------------- summary ----
printf '\n%sInstalled.%s\n\n' "$B$GRN" "$RST"
printf '  API        http://127.0.0.1:%s\n' "$PORT"
printf '  Code       %s\n' "$PREFIX"
printf '  Data       %s\n' "$DATA_DIR"
printf '  Config     %s\n' "$ENV_FILE"

if [ "$MANAGER" = "systemd" ]; then
  SC="systemctl"; JC="journalctl"
  [ "$SYSTEMD_SCOPE" = "user" ] && SC="systemctl --user" && JC="journalctl --user"
  printf '\n  %sManage%s\n' "$B" "$RST"
  printf '    %s status %s\n    %s restart %s\n    %s -u %s -f\n' "$SC" "$UNIT" "$SC" "$UNIT" "$JC" "$UNIT"
elif [ "$MANAGER" = "launchd" ]; then
  printf '\n  %sManage%s\n' "$B" "$RST"
  printf '    launchctl kickstart -k %s/%s\n    tail -f %s/surfingalien.log\n' \
    "$([ "$IS_ROOT" -eq 1 ] && echo system || echo "gui/$(id -u)")" "$LABEL" "$LOG_DIR"
fi

printf '\n  %sNext%s\n' "$B" "$RST"
printf '    surfingalien doctor\n'
printf '    surfingalien health\n'
if [ "$AUTH" = "session" ]; then
  if [ "${USER_COUNT:-0}" -eq 0 ] && [ -z "$ADMIN_USER" ]; then
    printf '    surfingalien user add <name> --role admin      %s# nobody can log in yet%s\n' "$DIM" "$RST"
  else
    printf '    surfingalien user add <name>                   %s# add more operators%s\n' "$DIM" "$RST"
  fi
fi
if [ "$AUTH" = "open" ]; then
  printf '\n  %swarning%s open mode: every caller shares one "anon" brain.\n' "$YLW" "$RST"
fi
printf '\n  Set OPENAI_API_KEY in %s for model answers;\n' "$ENV_FILE"
printf '  without one the offline brain still handles recognised commands.\n\n'
