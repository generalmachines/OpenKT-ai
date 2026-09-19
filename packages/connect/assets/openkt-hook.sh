#!/bin/sh
# openkt-hook.sh: connects an AI tool to OpenKT. Installed by packages/connect (openkt-connect).
# openkt-hook-version: 2
#
#   openkt-hook.sh <tool> <event>   the tool's hook JSON on stdin; prints the tool's expected JSON (or nothing)
#   openkt-hook.sh mcp              a stdio MCP server that forwards every message to <server>/mcp
#   openkt-hook.sh flush            sends what the outbox holds
#   openkt-hook.sh version
#
# events: session-start  prompt  stop  session-end  native-memory
#
# Talks to the OpenKT server directly: no app, no Node. Needs sh, curl, awk, sed, grep (macOS and Linux ship them).
# Credentials (shared with the kt CLI and the desktop app, Spec 06 §2):
#   server: $OPENKT_SERVER, else ~/.openkt/config.json "server", else ~/.openkt/credentials.json "server", else https://api.openkt.ai
#   token:  $OPENKT_TOKEN, else the macOS keychain (service openkt, account default), else ~/.openkt/credentials.json "token"
# The token never appears on a command line or in a tool's config: curl reads it from a 0600 file that is removed afterwards.
# Hooks never fail the tool: every path exits 0, recall gives up after 1.2 s, writes that cannot be sent wait in
# ~/.openkt/outbox/ (capped at 50 MB) and go out with the next hook call. Nothing a person typed is written to the log.

umask 077
LC_ALL=C
export LC_ALL

OKT_VERSION=2
OKT_HOME=${OPENKT_HOME:-${HOME:-/tmp}/.openkt}
OKT_AWK=${OPENKT_AWK:-awk}
OKT_GREP=${OPENKT_GREP:-grep}
OKT_RECALL_TIMEOUT=${OPENKT_RECALL_TIMEOUT:-1.2}
OKT_WRITE_TIMEOUT=${OPENKT_WRITE_TIMEOUT:-5}
OKT_MIN_SIMILARITY=${OPENKT_MIN_SIMILARITY:-0.5}
OKT_CONTEXT_BUDGET=1500
OKT_TURN_BUDGET=8192
OKT_OUTBOX_CAP_KB=51200
OKT_TMP=
OKT_JOBS=0

TOOL=${1:-}
EVENT=${2:-}

# ── small utilities ────────────────────────────────────────────────────────────────────────────────

okt_log() {
  mkdir -p "$OKT_HOME/logs" 2>/dev/null || return 0
  printf '%s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${TOOL:-?}" "${EVENT:-?}" "$*" >>"$OKT_HOME/logs/hook.log" 2>/dev/null || true
}

okt_cleanup() {
  [ -n "$OKT_TMP" ] && rm -rf "$OKT_TMP" 2>/dev/null
  return 0
}
trap okt_cleanup EXIT
trap 'exit 0' INT TERM HUP

# A private directory for this process (or one detached job): the curl config holding the token lives here.
okt_tmpdir() {
  [ -n "$OKT_TMP" ] && return 0
  mkdir -p "$OKT_HOME/run" 2>/dev/null || return 1
  OKT_TMP="$OKT_HOME/run/h.$$.$(date +%s).${1:-m}"
  mkdir "$OKT_TMP" 2>/dev/null || { OKT_TMP=; return 1; }
}

# okt_spawn CMD...: run CMD detached from the tool's pipes, with its own private directory. $! is its pid.
okt_spawn() {
  OKT_JOBS=$((OKT_JOBS + 1))
  ( trap - EXIT; OKT_TMP=; okt_tmpdir "j$OKT_JOBS" && "$@"; [ -n "$OKT_TMP" ] && rm -rf "$OKT_TMP" ) </dev/null >/dev/null 2>&1 &
}

# JSON → one "path<TAB>raw-literal" line per scalar (strings keep their quotes and escapes, so they can be spliced
# into new JSON without re-escaping). Paths join keys and array indexes with dots: data.items.0.text.
okt_flat() {
  "$OKT_GREP" -E -o '"([^"\\]|\\.)*"|-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?|true|false|null|[][{}:,]' 2>/dev/null | "$OKT_AWK" '
    BEGIN { d = 0; wk = 0 }
    {
      t = $0
      if (t == ":") next
      if (t == ",") { if (ty[d] == "a") ix[d]++; else wk = 1; next }
      if (t == "}" || t == "]") { if (d > 0 && !ne[d]) print pa[d] "\t" (t == "}" ? "{}" : "[]"); if (d > 0) d--; wk = 0; next }
      if (d > 0 && ty[d] == "o" && wk) { ky[d] = substr(t, 2, length(t) - 2); wk = 0; next }
      p = ""
      if (d > 0) { ne[d] = 1; s = (ty[d] == "a") ? ix[d] : ky[d]; p = (pa[d] == "") ? s : pa[d] "." s }
      if (t == "{") { d++; ty[d] = "o"; pa[d] = p; ne[d] = 0; wk = 1; next }
      if (t == "[") { d++; ty[d] = "a"; pa[d] = p; ne[d] = 0; ix[d] = 0; next }
      print p "\t" t
    }'
}

# jget <flat> <path>...: the raw literal of the first path present.
jget() {
  _f=$1; shift
  printf '%s\n' "$_f" | "$OKT_AWK" -F '\t' -v keys="$*" '
    BEGIN { n = split(keys, k, " ") }
    { v[$1] = substr($0, length($1) + 2) }
    END { for (i = 1; i <= n; i++) if (k[i] in v) { print v[k[i]]; exit } }'
}

# The inside of a JSON string literal, still escaped ("" for null/absent).
jinner() {
  case $1 in
    \"*\") _s=${1#\"}; printf '%s' "${_s%\"}" ;;
    *) printf '' ;;
  esac
}

# A JSON string literal → plain text (UTF-8).
junesc() {
  jinner "$1" | "$OKT_AWK" '
    BEGIN { u8 = (length("\303\251") == 1); hex = "0123456789abcdef" }
    function h(c) { return index(hex, tolower(c)) - 1 }
    function enc(cp) {
      if (cp < 128 || u8) return sprintf("%c", cp)
      if (cp < 2048) return sprintf("%c%c", 192 + int(cp / 64), 128 + cp % 64)
      return sprintf("%c%c%c", 224 + int(cp / 4096), 128 + int(cp / 64) % 64, 128 + cp % 64)
    }
    { s = s (NR > 1 ? "\n" : "") $0 }
    END {
      out = ""; n = length(s)
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (c != "\\") { out = out c; continue }
        i++; c = substr(s, i, 1)
        if (c == "n") out = out "\n"; else if (c == "t") out = out "\t"; else if (c == "r") out = out "\r"
        else if (c == "b" || c == "f") out = out ""
        else if (c == "u") { cp = 0; for (j = 1; j <= 4; j++) cp = cp * 16 + h(substr(s, i + j, 1)); i += 4; out = out enc(cp) }
        else out = out c
      }
      printf "%s", out
    }'
}

# stdin (plain text) → the inside of a JSON string literal.
jesc() {
  "$OKT_AWK" '
    function rep(s, a, b,   n, i, p, o) { n = split(s, p, a); o = p[1]; for (i = 2; i <= n; i++) o = o b p[i]; return o }
    {
      l = rep($0, "\\", "\\\\"); l = rep(l, "\"", "\\\""); l = rep(l, "\t", "\\t"); l = rep(l, "\r", "\\r")
      gsub(/[\001-\010\013\014\016-\037\177]/, "", l)
      o = o (NR > 1 ? "\\n" : "") l
    }
    END { printf "%s", o }'
}

# jcut <inner> <max>: cut an escaped string to at most <max> bytes without splitting an escape or a UTF-8 character.
jcut() {
  printf '%s' "$1" | "$OKT_AWK" -v max="$2" '
    BEGIN { u8 = (length("\303\251") == 1); if (!u8) for (i = 128; i < 256; i++) ord[sprintf("%c", i)] = i }
    { s = s (NR > 1 ? "\n" : "") $0 }
    END {
      if (length(s) <= max) { printf "%s", s; exit }
      s = substr(s, 1, max); n = length(s)
      k = 0; while (k < n && substr(s, n - k, 1) == "\\") k++
      if (k % 2 == 1) { s = substr(s, 1, n - 1); n-- }
      for (j = 1; j <= 5 && j < n; j++) {
        if (substr(s, n - j, 2) == "\\u") {
          b = 0; while (n - j - b > 0 && substr(s, n - j - b, 1) == "\\") b++
          if (b % 2 == 1 && j < 5) { s = substr(s, 1, n - j - 1); n = length(s) }
          break
        }
      }
      if (!u8) {
        for (i = n; i > 0 && i > n - 4; i--) {
          c = ord[substr(s, i, 1)] + 0
          if (c < 128) break
          if (c >= 192) { need = (c >= 240) ? 4 : (c >= 224) ? 3 : 2; if (n - i + 1 < need) s = substr(s, 1, i - 1); break }
        }
      }
      printf "%s…", s
    }'
}

okt_hash() { printf '%s' "$1" | cksum | "$OKT_AWK" '{ print $1 "-" $2 }'; }
okt_key() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-120; }

# ── credentials and HTTP ───────────────────────────────────────────────────────────────────────────

OKT_SERVER=
OKT_TOKEN=
okt_creds() {
  OKT_SERVER=${OPENKT_SERVER:-}
  OKT_TOKEN=${OPENKT_TOKEN:-}
  if [ -z "$OKT_TOKEN" ] && [ "${OPENKT_NO_KEYCHAIN:-0}" != 1 ] && command -v security >/dev/null 2>&1; then
    OKT_TOKEN=$(security find-generic-password -s openkt -a default -w 2>/dev/null) || OKT_TOKEN=
  fi
  if [ -z "$OKT_SERVER" ] && [ -f "$OKT_HOME/config.json" ]; then
    OKT_SERVER=$(junesc "$(jget "$(okt_flat <"$OKT_HOME/config.json")" server)")
  fi
  if [ -f "$OKT_HOME/credentials.json" ] && { [ -z "$OKT_TOKEN" ] || [ -z "$OKT_SERVER" ]; }; then
    _c=$(okt_flat <"$OKT_HOME/credentials.json")
    [ -z "$OKT_TOKEN" ] && OKT_TOKEN=$(junesc "$(jget "$_c" token)")
    [ -z "$OKT_SERVER" ] && OKT_SERVER=$(junesc "$(jget "$_c" server)")
  fi
  OKT_SERVER=${OKT_SERVER:-https://api.openkt.ai}
  OKT_SERVER=${OKT_SERVER%/}
  case $OKT_TOKEN in *[!A-Za-z0-9._~+/=-]*) OKT_TOKEN= ;; esac
}

# The curl config that carries the token: 0600, inside this run's private directory.
okt_authfile() {
  okt_tmpdir || return 1
  [ -f "$OKT_TMP/auth" ] && return 0
  printf 'header = "Authorization: Bearer %s"\n' "$OKT_TOKEN" >"$OKT_TMP/auth"
}

# okt_http METHOD PATH BODY MAXTIME → OKT_STATUS (000 on network failure) and OKT_BODY
OKT_STATUS=000
OKT_BODY=
okt_http() {
  OKT_STATUS=000; OKT_BODY=
  [ -n "$OKT_TOKEN" ] || { OKT_STATUS=401; return 0; }
  okt_authfile || return 0
  _out="$OKT_TMP/resp.$$.$(okt_hash "$2$1")"
  if [ -n "$3" ]; then
    OKT_STATUS=$(printf '%s' "$3" | curl -sS -o "$_out" -w '%{http_code}' --connect-timeout 1 --max-time "$4" -X "$1" \
      -K "$OKT_TMP/auth" -H 'Content-Type: application/json' -H 'Accept: application/json' \
      -A "openkt-hook/$OKT_VERSION ($TOOL)" --data-binary @- "$OKT_SERVER$2" 2>/dev/null) || true
  else
    OKT_STATUS=$(curl -sS -o "$_out" -w '%{http_code}' --connect-timeout 1 --max-time "$4" -X "$1" \
      -K "$OKT_TMP/auth" -H 'Accept: application/json' -A "openkt-hook/$OKT_VERSION ($TOOL)" "$OKT_SERVER$2" 2>/dev/null) || true
  fi
  case $OKT_STATUS in [0-9][0-9][0-9]) ;; *) OKT_STATUS=000 ;; esac
  [ -f "$_out" ] && OKT_BODY=$(cat "$_out") && rm -f "$_out"
  return 0
}

okt_ok() { case $OKT_STATUS in 2??) return 0 ;; *) return 1 ;; esac; }
# Worth keeping for later: offline, server errors, signed out, rate limited.
okt_retryable() { case $OKT_STATUS in 000 | 5?? | 401 | 403 | 408 | 429) return 0 ;; *) return 1 ;; esac; }

# ── sessions, spaces, outbox ───────────────────────────────────────────────────────────────────────

# The space for a folder: the nearest .openkt/manifest.json (below $HOME), else the folder's entry in
# ~/.openkt/folders.json (one folder per line, written by packages/connect). Unknown git repositories are
# noted in ~/.openkt/folders.pending so the app and the CLI can offer to file them in a team space.
okt_space() {
  _d=$1; _git=
  [ -n "$_d" ] || return 0
  while [ -n "$_d" ] && [ "$_d" != / ]; do
    if [ "$_d" != "${HOME:-}" ] && [ -f "$_d/.openkt/manifest.json" ]; then
      _p=$(junesc "$(jget "$(okt_flat <"$_d/.openkt/manifest.json")" project_id)")
      [ -n "$_p" ] && { printf '%s' "$_p"; return 0; }
    fi
    if [ -f "$OKT_HOME/folders.json" ]; then
      _line=$("$OKT_GREP" -F "\"$_d\": {" "$OKT_HOME/folders.json" 2>/dev/null | head -n 1)
      if [ -n "$_line" ]; then
        _p=$(printf '%s' "$_line" | sed -n 's/.*"space_id": *"\([^"]*\)".*/\1/p')
        printf '%s' "$_p"
        return 0
      fi
    fi
    [ -z "$_git" ] && [ -e "$_d/.git" ] && _git=$_d
    _d=${_d%/*}
  done
  if [ -n "$_git" ] && ! "$OKT_GREP" -q -F "$_git	" "$OKT_HOME/folders.pending" 2>/dev/null; then
    mkdir -p "$OKT_HOME" && printf '%s\t%s\n' "$_git" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$OKT_HOME/folders.pending"
  fi
  return 0
}

okt_map_file() { printf '%s/state/sessions/%s' "$OKT_HOME" "$1"; }

# Which OpenKT session of this conversation is current: 1 for the first, 2 after the first closed while idle, …
okt_gen() {
  _gn=$(cat "$(okt_map_file "$1").gen" 2>/dev/null)
  case $_gn in '' | *[!0-9]*) _gn=1 ;; esac
  printf '%s' "$_gn"
}

# okt_create_gen CREATE_BODY GEN: the create body of generation GEN — external_id "<id>" becomes "<id>#GEN" (GEN ≥ 2).
# CREATE_BODY starts with external_id when the tool names its conversation (okt_context), so the suffix goes right
# before the "source" field.
okt_create_gen() {
  case $1 in
    '{"external_id":"'*) if [ "$2" -gt 1 ]; then printf '%s' "$1" | sed "s/\",\"source\":\"/#$2\",\"source\":\"/"; return 0; fi ;;
  esac
  printf '%s' "$1"
}

# okt_open KEY CREATE_BODY GEN TIMEOUT: POST /v1/sessions for generation GEN and remember the session; prints its id.
# The server answers a known (source, external_id) with that session (Spec 04); a closed one means the conversation
# went idle, so it goes on in the next generation. Returns 1 (OKT_STATUS set) when no session could be had.
okt_open() {
  _om=$(okt_map_file "$1"); _og=$3; _otry=0
  while [ $_otry -lt 3 ]; do
    _obody=$(okt_create_gen "$2" "$_og")
    okt_http POST /v1/sessions "$_obody" "$4"
    # A folder filed under a space this person can no longer write to: fall back to the personal space.
    if ! okt_ok && ! okt_retryable || [ "$OKT_STATUS" = 403 ]; then
      case $_obody in
        *'"project_id":'*)
          _obody=$(printf '%s' "$_obody" | sed 's/,"project_id":"[^"]*"//')
          okt_http POST /v1/sessions "$_obody" "$4"
          ;;
      esac
    fi
    okt_ok || return 1
    _of=$(printf '%s' "$OKT_BODY" | okt_flat)
    _osid=$(junesc "$(jget "$_of" data.id)")
    [ -n "$_osid" ] || return 1
    if [ "$(junesc "$(jget "$_of" data.status)")" = closed ]; then
      _og=$((_og + 1)); _otry=$((_otry + 1))
      continue
    fi
    mkdir -p "$OKT_HOME/state/sessions" 2>/dev/null
    printf '%s' "$_osid" >"$_om"
    [ "$_og" -gt 1 ] && printf '%s' "$_og" >"$_om.gen"
    printf '%s' "$_osid"
    return 0
  done
  return 1
}

# okt_session KEY CREATE_BODY TIMEOUT → the OpenKT session id for this tool session (created once, then remembered).
okt_session() {
  _m=$(okt_map_file "$1")
  [ -s "$_m" ] && { cat "$_m"; return 0; }
  [ -n "$2" ] || return 0
  mkdir -p "$OKT_HOME/state/sessions" 2>/dev/null
  # One creator per tool session: a prompt that arrives while session-start is still creating waits for it.
  if ! mkdir "$_m.lock" 2>/dev/null; then
    [ -n "$(find "$_m.lock" -maxdepth 0 -mmin +1 2>/dev/null)" ] && rm -rf "$_m.lock"
    _w=0
    while [ $_w -lt 20 ] && [ ! -s "$_m" ] && [ -d "$_m.lock" ]; do sleep 0.2 2>/dev/null || sleep 1; _w=$((_w + 1)); done
    [ -s "$_m" ] && { cat "$_m"; return 0; }
    mkdir "$_m.lock" 2>/dev/null || return 0
  fi
  if ! okt_open "$1" "$2" "$(okt_gen "$1")" "$3" && ! okt_retryable; then
    # Refused for good (not offline, not signed out): writes for this session are dropped instead of blocking the outbox.
    printf '%s' "$OKT_STATUS" >"$_m.failed"
    okt_log "session refused (status $OKT_STATUS)"
  fi
  rmdir "$_m.lock" 2>/dev/null
  return 0
}

# okt_session_start KEY CREATE_BODY TIMEOUT: at the start (or resume) of a conversation, make sure its session is
# open. A remembered session is asked for again by its external id: the server answers with the same session, or —
# when it closed while idle — the conversation goes on in a new one. Never reuses a closed session.
okt_session_start() {
  case $2 in
    '{"external_id":"'*)
      if [ -s "$(okt_map_file "$1")" ]; then okt_open "$1" "$2" "$(okt_gen "$1")" "$3" >/dev/null; return 0; fi ;;
  esac
  okt_session "$1" "$2" "$3" >/dev/null
  return 0
}

# The server refused a turn because the session is closed (Spec 04: 409 session_closed).
okt_closed() {
  [ "$OKT_STATUS" = 409 ] || return 1
  case $OKT_BODY in *'"session_closed"'*) return 0 ;; esac
  return 1
}

# okt_rotate KEY CREATE_BODY CLOSED_SID TIMEOUT → the session this conversation continues in, once CLOSED_SID closed:
# the one another hook already moved to, else the next generation. Empty when none could be had (a refusal for good
# is marked .failed, as in okt_session).
okt_rotate() {
  _rcur=$(cat "$(okt_map_file "$1")" 2>/dev/null)
  if [ -n "$_rcur" ] && [ "$_rcur" != "$3" ]; then printf '%s' "$_rcur"; return 0; fi
  [ -n "$2" ] || return 0
  if ! okt_open "$1" "$2" $(($(okt_gen "$1") + 1)) "$4" && ! okt_retryable; then
    printf '%s' "$OKT_STATUS" >"$(okt_map_file "$1").failed"
    okt_log "new session refused (status $OKT_STATUS)"
  fi
  return 0
}

OKT_SEQ=0
# okt_queue KEY CREATE_BODY METHOD PATH BODY: keep a write for later. PATH may contain :sid.
okt_queue() {
  mkdir -p "$OKT_HOME/outbox" 2>/dev/null || return 0
  _kb=$(du -sk "$OKT_HOME/outbox" 2>/dev/null | "$OKT_AWK" '{ print $1 + 0 }')
  while [ "${_kb:-0}" -gt "$OKT_OUTBOX_CAP_KB" ]; do
    _old=$(ls "$OKT_HOME/outbox" | "$OKT_GREP" '\.req$' | sort | head -n 1)
    [ -n "$_old" ] || break
    rm -f "$OKT_HOME/outbox/$_old"
    okt_log "outbox full: dropped the oldest write"
    _kb=$(du -sk "$OKT_HOME/outbox" 2>/dev/null | "$OKT_AWK" '{ print $1 + 0 }')
  done
  OKT_SEQ=$((OKT_SEQ + 1))
  _f="$OKT_HOME/outbox/$(date +%s)-$$-$OKT_SEQ.req"
  { printf 'key %s\n' "${1:--}"; printf 'create %s\n' "${2:--}"; printf 'method %s\n' "$3"; printf 'path %s\n' "$4"; printf 'body %s\n' "${5:--}"; } >"$_f.tmp" && mv "$_f.tmp" "$_f"
  okt_log "queued $3 $(printf '%s' "$4" | sed 's/[0-9a-f-]\{36\}/<id>/g') (status $OKT_STATUS)"
}

# okt_send KEY CREATE_BODY METHOD PATH BODY: send now; keep it for later when it cannot go out.
okt_send() {
  _path=$4; _sid=
  case $_path in
    *:sid*)
      _sid=$(okt_session "$1" "$2" "$OKT_WRITE_TIMEOUT")
      if [ -z "$_sid" ]; then [ -f "$(okt_map_file "$1").failed" ] || okt_queue "$@"; return 0; fi
      _path=$(printf '%s' "$_path" | sed "s/:sid/$_sid/")
      ;;
  esac
  okt_http "$3" "$_path" "$5" "$OKT_WRITE_TIMEOUT"
  if okt_ok; then return 0; fi
  okt_after_closed "$1" "$2" "$3" "$4" "$5" "$_sid" && return 0
  if okt_retryable; then okt_queue "$@"; else okt_log "dropped $3 (status $OKT_STATUS)"; fi
  return 0
}

# okt_after_closed KEY CREATE_BODY METHOD PATH BODY SID: the write just sent to SID was refused because the session
# closed while idle. Continue the conversation in a new session and send it there, once, silently. 0 when it went out;
# otherwise OKT_STATUS says what to do with the write (000 = keep it for later).
okt_after_closed() {
  [ -n "$6" ] && [ -n "$2" ] && okt_closed || return 1
  _new=$(okt_rotate "$1" "$2" "$6" "$OKT_WRITE_TIMEOUT")
  if [ -z "$_new" ]; then
    [ -f "$(okt_map_file "$1").failed" ] || OKT_STATUS=000
    return 1
  fi
  okt_http "$3" "$(printf '%s' "$4" | sed "s/:sid/$_new/")" "$5" "$OKT_WRITE_TIMEOUT"
  okt_ok || return 1
  okt_log "session closed while idle: continued in a new session"
  return 0
}

okt_flush() {
  [ -d "$OKT_HOME/outbox" ] || return 0
  [ -n "$OKT_TOKEN" ] || return 0
  ls "$OKT_HOME/outbox" 2>/dev/null | "$OKT_GREP" -q '\.req$' || return 0
  _lock="$OKT_HOME/outbox/.lock"
  if ! mkdir "$_lock" 2>/dev/null; then
    [ -n "$(find "$_lock" -maxdepth 0 -mmin +2 2>/dev/null)" ] || return 0
    rm -rf "$_lock"; mkdir "$_lock" 2>/dev/null || return 0
  fi
  for _name in $(ls "$OKT_HOME/outbox" | "$OKT_GREP" '\.req$' | sort -t - -k1,1n -k2,2n -k3,3n); do
    _r="$OKT_HOME/outbox/$_name"
    [ -f "$_r" ] || continue
    _k=$(sed -n 's/^key //p' "$_r"); _c=$(sed -n 's/^create //p' "$_r")
    _me=$(sed -n 's/^method //p' "$_r"); _pa=$(sed -n 's/^path //p' "$_r"); _bo=$(sed -n 's/^body //p' "$_r")
    [ "$_c" = - ] && _c=
    [ "$_bo" = - ] && _bo=
    _fsid=
    case $_pa in
      *:sid*)
        OKT_STATUS=000
        _sid=$(okt_session "$_k" "$_c" "$OKT_WRITE_TIMEOUT")
        if [ -z "$_sid" ]; then
          # No session and nothing to create it from (a close whose session never existed), or the server refused
          # the session for good: drop it. Otherwise (offline) stop and keep the order.
          if [ -z "$_c" ] || [ -f "$(okt_map_file "$_k").failed" ]; then rm -f "$_r"; continue; fi
          break
        fi
        _fsid=$_sid
        _pa=$(printf '%s' "$_pa" | sed "s/:sid/$_sid/")
        ;;
    esac
    okt_http "$_me" "$_pa" "$_bo" "$OKT_WRITE_TIMEOUT"
    okt_ok || okt_after_closed "$_k" "$_c" "$_me" "$(sed -n 's/^path //p' "$_r")" "$_bo" "$_fsid"
    if okt_ok || ! okt_retryable; then
      rm -f "$_r"
      case $_pa in */close) rm -f "$(okt_map_file "$_k")" ;; esac
    else
      break
    fi
  done
  rmdir "$_lock" 2>/dev/null
  return 0
}

# ── tool input and output ──────────────────────────────────────────────────────────────────────────

IN=
FLAT=
okt_read_input() {
  IN=$(cat 2>/dev/null) || IN=
  FLAT=$(printf '%s' "$IN" | okt_flat)
}

okt_client() {
  case $TOOL in
    claude-code)
      # VS Code Copilot and Devin Local also run the hooks in ~/.claude/settings.json.
      if [ -n "${CLAUDE_PROJECT_DIR:-}${CLAUDECODE:-}" ]; then printf 'claude-code'
      elif [ -n "${VSCODE_PID:-}${VSCODE_CWD:-}${VSCODE_IPC_HOOK:-}" ]; then printf 'vscode'
      else printf 'claude-compatible'; fi ;;
    *) printf '%s' "$TOOL" ;;
  esac
}

# The session's source: the tool's own name when the server knows it (Spec 04 sources), else connector.
okt_source() {
  case $1 in
    claude-code | codex | cursor | gemini | windsurf | opencode | vscode | claude-desktop) printf '%s' "$1" ;;
    *) printf 'connector' ;;
  esac
}

# context_md (escaped) → what this tool reads from a hook's stdout.
okt_emit() {
  _ctx=$2
  case "$TOOL:$1" in
    claude-code:session-start | codex:session-start | gemini:session-start)
      [ -n "$_ctx" ] && printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$_ctx" ;;
    claude-code:prompt | codex:prompt)
      [ -n "$_ctx" ] && printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$_ctx" ;;
    gemini:prompt)
      [ -n "$_ctx" ] && printf '{"hookSpecificOutput":{"hookEventName":"BeforeAgent","additionalContext":"%s"}}\n' "$_ctx" ;;
    cursor:session-start)
      [ -n "$_ctx" ] && printf '{"additional_context":"%s"}\n' "$_ctx" ;;
    cursor:prompt)
      printf '{"continue":true}\n' ;;
    agent:session-start | agent:prompt)
      printf '{"context_md":"%s"}\n' "$_ctx" ;;
  esac
  return 0
}

# ── events ─────────────────────────────────────────────────────────────────────────────────────────

CSID=
CWD=
KEY=
SPACE=
CREATE=
okt_context() {
  CSID=$(junesc "$(jget "$FLAT" session_id conversation_id trajectory_id sessionId)")
  CWD=$(junesc "$(jget "$FLAT" cwd workspace_roots.0)")
  [ -n "$CWD" ] || CWD=${CLAUDE_PROJECT_DIR:-${PWD:-}}
  # The tool's own conversation id is the session's external_id (Spec 04: the same one twice → the same session).
  # A parent-pid stand-in is not: pids are reused.
  _ext=
  [ -n "$CSID" ] && [ "${#CSID}" -le 200 ] && _ext=$(printf '%s' "$CSID" | jesc)
  [ -n "$CSID" ] || CSID="ppid-${PPID:-0}"
  KEY="$(okt_key "$TOOL")__$(okt_key "$CSID")"
  SPACE=$(okt_space "$CWD")
  _client=$(okt_client)
  _title=$(printf '%s' "${CWD##*/}" | jesc)
  _cwd=$(printf '%s' "$CWD" | jesc)
  _csid=$(printf '%s' "$CSID" | jesc)
  _extf=
  [ -n "$_ext" ] && _extf="\"external_id\":\"$_ext\","
  CREATE="{$_extf\"source\":\"$(okt_source "$_client")\",\"client\":\"$_client\",\"title\":\"${_title:-$_client session}\",\"metadata\":{\"cwd\":\"$_cwd\",\"client_session_id\":\"$_csid\",\"via\":\"openkt-hook/$OKT_VERSION\"}"
  [ -n "$SPACE" ] && CREATE="$CREATE,\"project_id\":\"$SPACE\""
  CREATE="$CREATE}"
}

okt_space_field() { [ -n "$SPACE" ] && printf ',"project_id":"%s"' "$SPACE"; return 0; }

# Recall / prime results → an escaped markdown list with authors, within the budget.
okt_format() {
  # The heading goes through the environment: awk -v would turn its \n escape into a raw newline.
  printf '%s\n' "$1" | OKT_FMT_HEAD=$3 "$OKT_AWK" -F '\t' -v prefix="$2" -v budget="$OKT_CONTEXT_BUDGET" -v minsim="$4" '
    BEGIN { head = ENVIRON["OKT_FMT_HEAD"] }
    function inner(v) { if (v ~ /^".*"$/) return substr(v, 2, length(v) - 2); return "" }
    function cut(s, m,   n, k) {
      if (length(s) <= m) return s
      s = substr(s, 1, m); n = length(s)
      k = 0; while (k < n && substr(s, n - k, 1) == "\\") k++
      if (k % 2 == 1) s = substr(s, 1, n - 1)
      sub(/\\u[0-9a-fA-F]?[0-9a-fA-F]?[0-9a-fA-F]?$/, "", s)
      while (length(s) > 0 && substr(s, length(s), 1) >= "\200") s = substr(s, 1, length(s) - 1)
      return s "…"
    }
    {
      p = $1; v = substr($0, length($1) + 2)
      if (index(p, prefix ".") != 1) next
      rest = substr(p, length(prefix) + 2); dot = index(rest, ".")
      if (dot == 0) next
      i = substr(rest, 1, dot - 1) + 0; f = substr(rest, dot + 1)
      if (i + 1 > n) n = i + 1
      if (f == "content") c[i] = inner(v)
      else if (f == "owner.display_name") a[i] = inner(v)
      else if (f == "project.name") sp[i] = inner(v)
      else if (f == "created_at") dt[i] = substr(inner(v), 1, 10)
      else if (f == "similarity") sim[i] = v + 0
    }
    END {
      out = ""
      for (i = 0; i < n; i++) {
        if (c[i] == "") continue
        if (minsim > 0 && (i in sim) && sim[i] < minsim) continue
        line = "- " cut(c[i], 400) " — " (a[i] != "" ? a[i] : "someone")
        if (sp[i] != "") line = line ", " sp[i]
        if (dt[i] != "") line = line ", " dt[i]
        if (length(out) + length(line) + 2 > budget - length(head)) break
        out = out line "\\n"
      }
      if (out != "") printf "%s%s", head, out
    }'
}

ev_session_start() {
  okt_context
  okt_creds
  [ -n "$OKT_TOKEN" ] || { okt_log "signed out"; okt_emit session-start ""; return 0; }
  # Create the session — or check the remembered one is still open — in the background while the brief is fetched:
  # the tool waits for one call, not two.
  okt_spawn okt_session_start "$KEY" "$CREATE" 1.5
  _pid=$!
  okt_http POST /v1/prime "{\"with_briefing\":true$(okt_space_field)}" "$OKT_RECALL_TIMEOUT"
  _ctx=
  if okt_ok; then
    _pf=$(printf '%s' "$OKT_BODY" | okt_flat)
    _name=$(jinner "$(jget "$_pf" data.project.name)")
    _sum=$(jinner "$(jget "$_pf" data.briefing.summary)")
    _head="OpenKT: shared context for this work (space: ${_name:-Personal}). Cite the author when you use it.\\n"
    [ -n "$_sum" ] && _head="$_head$(jcut "$_sum" 600)\\n"
    _list=$(okt_format "$_pf" data.memories "Recent context:\\n" 0)
    _ctx="$_head$_list"
    [ -n "$_list" ] || _ctx="${_head}Nothing saved in this space yet. Save decisions with kt_save_memory as they happen.\\n"
  else
    okt_log "brief unavailable (status $OKT_STATUS)"
  fi
  [ -n "$_pid" ] && wait "$_pid" 2>/dev/null
  _sid=$(cat "$(okt_map_file "$KEY")" 2>/dev/null)
  if [ -n "$_sid" ]; then
    _ctx="${_ctx}This conversation is already saved as OpenKT session $_sid by hooks: pass session_id \\\"$_sid\\\" to kt_recall and kt_save_memory, and do not call kt_session_start or kt_session_end.\n"
  fi
  okt_emit session-start "$_ctx"
  okt_spawn okt_flush
}

ev_prompt() {
  okt_context
  _p=$(jget "$FLAT" prompt tool_info.user_prompt)
  _pi=$(jinner "$_p")
  [ -n "$_pi" ] || { okt_emit prompt ""; return 0; }
  okt_creds
  _turn="{\"role\":\"user\",\"content\":\"$(jcut "$_pi" "$OKT_TURN_BUDGET")\",\"metadata\":{\"via\":\"openkt-hook/$OKT_VERSION\"}}"
  if [ -z "$OKT_TOKEN" ]; then
    okt_queue "$KEY" "$CREATE" POST /v1/sessions/:sid/turns "$_turn"
    okt_emit prompt ""
    return 0
  fi
  okt_spawn okt_send_then_flush "$KEY" "$CREATE" POST /v1/sessions/:sid/turns "$_turn"
  _ctx=
  if [ "${#_pi}" -ge 12 ]; then
    okt_http POST /v1/memories/recall "{\"query\":\"$(jcut "$_pi" 1900)\",\"limit\":5$(okt_space_field)}" "$OKT_RECALL_TIMEOUT"
    if okt_ok; then
      _ctx=$(okt_format "$(printf '%s' "$OKT_BODY" | okt_flat)" data "Context from OpenKT that may be relevant (cite the author if you use it):\\n" "$OKT_MIN_SIMILARITY")
    else
      okt_log "recall skipped (status $OKT_STATUS)"
    fi
  fi
  okt_emit prompt "$_ctx"
}
okt_send_then_flush() { okt_send "$@"; okt_flush; }

ev_stop() {
  okt_context
  _a=$(jinner "$(jget "$FLAT" last_assistant_message text prompt_response tool_info.response)")
  [ -n "$_a" ] || return 0
  okt_creds
  _turn="{\"role\":\"assistant\",\"content\":\"$(jcut "$_a" "$OKT_TURN_BUDGET")\",\"metadata\":{\"via\":\"openkt-hook/$OKT_VERSION\"}}"
  if [ -z "$OKT_TOKEN" ]; then okt_queue "$KEY" "$CREATE" POST /v1/sessions/:sid/turns "$_turn"; return 0; fi
  okt_spawn okt_send_then_flush "$KEY" "$CREATE" POST /v1/sessions/:sid/turns "$_turn"
}

ev_session_end() {
  okt_context
  okt_creds
  _m=$(okt_map_file "$KEY")
  if [ ! -s "$_m" ] && ! ls "$OKT_HOME/outbox" 2>/dev/null | "$OKT_GREP" -q '\.req$'; then return 0; fi
  if [ -z "$OKT_TOKEN" ]; then okt_queue "$KEY" "" POST /v1/sessions/:sid/close '{}'; return 0; fi
  okt_spawn ev_session_end_bg
}
ev_session_end_bg() {
  okt_flush
  _m=$(okt_map_file "$KEY")
  [ -s "$_m" ] || return 0
  okt_send "$KEY" "" POST /v1/sessions/:sid/close '{}'
  okt_ok && rm -f "$_m"
  return 0
}

# Claude Code's own memory files (~/.claude/projects/<project>/memory/*.md) and Gemini CLI's save_memory facts
# become OpenKT facts tagged native-memory. One fact per file (or per Gemini fact); a changed file replaces its fact.
okt_kind() {
  case $1 in
    feedback) printf 'anti-pattern' ;; project) printf 'decision' ;; reference | user) printf 'context' ;; *) printf 'note' ;;
  esac
}

okt_native_save() { # ID CONTENT_ESCAPED KIND TAG
  _st="$OKT_HOME/state/native/$(okt_key "$1")"
  _h=$(okt_hash "$2")
  _old=
  if [ -s "$_st" ]; then
    [ "$(cut -d ' ' -f1 "$_st")" = "$_h" ] && return 0
    _old=$(cut -d ' ' -f2 "$_st")
  fi
  _body="{\"content\":\"$2\",\"kind\":\"$3\",\"tag_slugs\":[\"native-memory\"${4:+,\"$4\"}],\"source_refs\":[]$(okt_space_field)}"
  okt_http POST /v1/memories "$_body" "$OKT_WRITE_TIMEOUT"
  if okt_ok; then
    _id=$(junesc "$(jget "$(printf '%s' "$OKT_BODY" | okt_flat)" data.id)")
    mkdir -p "$OKT_HOME/state/native" && printf '%s %s\n' "$_h" "${_id:--}" >"$_st"
    [ -n "$_old" ] && [ "$_old" != - ] && okt_http DELETE "/v1/memories/$_old" "" "$OKT_WRITE_TIMEOUT"
    okt_log "native memory synced"
  elif okt_retryable; then
    okt_queue - - POST /v1/memories "$_body"
  fi
  return 0
}

okt_native_file() {
  _f=$1
  case $_f in
    */.claude/projects/*/memory/*.md | */.claude-accounts/*/projects/*/memory/*.md) ;;
    *) return 0 ;;
  esac
  [ "${_f##*/}" = MEMORY.md ] && return 0
  [ -f "$_f" ] || return 0
  _type=$(sed -n '1,/^---$/{ /^type:/{ s/^type:[[:space:]]*//; s/["'\'']//g; p; q; }; }' "$_f" | head -n 1 | tr 'A-Z' 'a-z')
  _name=$(sed -n '1,20{ /^name:/{ s/^name:[[:space:]]*//; s/["'\'']//g; p; q; }; }' "$_f" | head -n 1)
  _body=$("$OKT_AWK" 'NR == 1 && $0 == "---" { fm = 1; next } fm && $0 == "---" { fm = 0; next } !fm { print }' "$_f" | jesc)
  [ -n "$_body" ] || return 0
  _nm=$(printf '%s' "${_name:-${_f##*/}}" | jesc)
  _t=$(printf '%s' "$_type" | tr -c 'a-z0-9-' '-' | sed 's/^-*//; s/-*$//')
  case $_t in ?*?) ;; *) _t= ;; esac
  okt_native_save "claude-code:$_f" "$_nm\\n\\n$(jcut "$_body" 18000)" "$(okt_kind "$_type")" "$_t"
}

ev_native_memory() {
  okt_context
  okt_creds
  [ -n "$OKT_TOKEN" ] || return 0
  case $TOOL in
    gemini)
      _fact=$(jinner "$(jget "$FLAT" tool_input.fact tool_args.fact)")
      [ -n "$_fact" ] && okt_spawn okt_native_save "gemini:$(okt_hash "$_fact")" "$(jcut "$_fact" 18000)" note gemini
      ;;
    *)
      _fp=$(junesc "$(jget "$FLAT" tool_input.file_path tool_input.path file_path)")
      case $_fp in
        */.claude/projects/*/memory/*.md | */.claude-accounts/*/projects/*/memory/*.md) okt_spawn okt_native_file "$_fp" ;;
      esac
      ;;
  esac
  return 0
}

# Every existing Claude Code memory file, once (run by openkt-connect when native memory sync is switched on).
ev_native_scan() {
  okt_creds
  [ -n "$OKT_TOKEN" ] || return 0
  SPACE=
  for _f in "${HOME:-}"/.claude/projects/*/memory/*.md; do
    [ -f "$_f" ] && okt_native_file "$_f"
  done
  return 0
}

# ── MCP over stdio ─────────────────────────────────────────────────────────────────────────────────

okt_mcp_error() { # RAW_ID MESSAGE
  [ -n "$1" ] || return 0
  printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32001,"message":"%s"}}\n' "$1" "$2"
}

ev_mcp() {
  okt_creds
  okt_tmpdir || exit 0
  _sidh=
  while IFS= read -r _line || [ -n "$_line" ]; do
    [ -n "$_line" ] || continue
    _id=$(jget "$(printf '%s' "$_line" | okt_flat)" id)
    if [ -z "$OKT_TOKEN" ]; then
      okt_creds; rm -f "$OKT_TMP/auth"
      [ -n "$OKT_TOKEN" ] || { okt_mcp_error "$_id" "OpenKT: not signed in. Sign in with the OpenKT app or run: kt auth login"; continue; }
    fi
    okt_authfile
    : >"$OKT_TMP/mcp.h"
    _st=$(printf '%s' "$_line" | curl -sS -o "$OKT_TMP/mcp.b" -D "$OKT_TMP/mcp.h" -w '%{http_code}' --connect-timeout 5 --max-time 120 \
      -X POST -K "$OKT_TMP/auth" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
      ${_sidh:+-H "Mcp-Session-Id: $_sidh"} -A "openkt-hook/$OKT_VERSION (mcp)" --data-binary @- "$OKT_SERVER/mcp" 2>/dev/null) || _st=000
    _h=$(tr -d '\r' <"$OKT_TMP/mcp.h" | "$OKT_GREP" -i '^mcp-session-id:' | head -n 1 | sed 's/^[^:]*:[[:space:]]*//')
    [ -n "$_h" ] && _sidh=$_h
    case $_st in
      2??)
        if tr -d '\r' <"$OKT_TMP/mcp.h" | "$OKT_GREP" -qi '^content-type:.*text/event-stream'; then
          tr -d '\r' <"$OKT_TMP/mcp.b" | sed -n 's/^data: \{0,1\}//p' | "$OKT_GREP" -v '^[[:space:]]*$'
        elif [ -s "$OKT_TMP/mcp.b" ]; then
          tr -d '\r\n' <"$OKT_TMP/mcp.b"; printf '\n'
        fi
        ;;
      401) OKT_TOKEN=; okt_mcp_error "$_id" "OpenKT: your sign-in has expired. Sign in again with the OpenKT app or run: kt auth login" ;;
      000) okt_mcp_error "$_id" "OpenKT: cannot reach $OKT_SERVER" ;;
      *) okt_mcp_error "$_id" "OpenKT: the server answered $_st" ;;
    esac
  done
  return 0
}

# ── main ───────────────────────────────────────────────────────────────────────────────────────────

# Tests source this file with OPENKT_HOOK_LIB=1 to call the functions above one by one.
[ "${OPENKT_HOOK_LIB:-0}" = 1 ] && return 0 2>/dev/null

# One private directory per run, made before any $(…) so command substitutions share it instead of racing for it.
case $TOOL in version) ;; *) okt_tmpdir ;; esac
case $TOOL in
  version) printf '{"version":%s}\n' "$OKT_VERSION"; exit 0 ;;
  mcp) EVENT=mcp; ev_mcp; exit 0 ;;
  flush) EVENT=flush; okt_creds; okt_flush; exit 0 ;;
  native-scan) TOOL=claude-code; EVENT=native-scan; ev_native_scan; exit 0 ;;
esac

command -v curl >/dev/null 2>&1 || exit 0
okt_read_input
case $EVENT in
  session-start) ev_session_start ;;
  prompt) ev_prompt ;;
  stop | turn) ev_stop ;;
  session-end) ev_session_end ;;
  native-memory) ev_native_memory ;;
  *) okt_log "unknown event" ;;
esac
exit 0
