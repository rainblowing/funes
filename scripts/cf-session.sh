#!/usr/bin/env bash
# cf-session.sh <act>… — the one way to act on the Cloudflare account (PLAN-0.5.0 item 36;
# record 24 §10, Q1 = (a)). It logs in, runs the named acts in argv order, and logs out from the one
# `trap … EXIT`, so the logout runs on success, on a failed act and on a failed login. No Cloudflare
# write credential stays at rest on the machine. It takes no --name and no --env: one config, one Worker.
#
# Acts:
#   deploy                       funes-cf's workerd tests first (fail closed), then `wrangler deploy`
#                                of funes-taste, the edge Worker of every star key in its bucket
#                                (ADR-0024). Never `versions upload`: a deploy is non-gradual. A
#                                change to a star's R2 config is followed by a deploy.
#   bucket-create <name>         an R2 bucket
#   bucket-delete <name>
#   secret-put <NAME> <worker>   the value is one line of stdin (or a no-echo prompt on a terminal);
#                                it is piped to wrangler, never on argv, never echoed
#   deploy-bot                   the bot repo's deploy script (item 56) in its in-session mode, from
#                                the side-by-side checkout ../taste-bot
#   probe                        record 35 E7: deploy funes-probe, pipe it a per-session random
#                                bearer, call it, save its report under ~/.funes/cf-probe/, then
#                                delete the Worker and the throwaway bucket
#
# The whole argv is checked before the login, so a typo costs no consent screen. Nothing but
# secret-put reads stdin.
#
# Never `wrangler dev --remote` (record 31): there is no local `ai` binding, and the deployed
# throwaway funes-probe is the only path to Workers AI. funes-cf's configs carry no remote binding.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CF="$ROOT/packages/funes-cf"
WRANGLER="$CF/node_modules/.bin/wrangler" # the package-pinned 4.149.0, never a global one
PROBE_CONFIG="$CF/probe/wrangler.jsonc"
PROBE_BUCKET="funes-probe-spike" # = probe/wrangler.jsonc's bucket_name (test/config.node.ts)
BOT_DEPLOY="$ROOT/../taste-bot/deploy.sh"
# The Workers a secret may go to: the edge Worker (TELEGRAM_LOGIN_KEY, per deployment, never per
# star) and the bot. Their names are the operator's (ADR-0024).
SECRET_WORKERS=" funes-taste taste-bot "
REPORTS="$HOME/.funes/cf-probe"
export WRANGLER_SEND_METRICS=false

die() { echo "cf-session: $*" >&2; exit 2; }
w() { "$WRANGLER" "$@" </dev/null; }

[ $# -gt 0 ] || die "usage: cf-session.sh <act>… (deploy | bucket-create <name> | bucket-delete <name> | secret-put <NAME> <worker> | deploy-bot | probe)"
[ -z "${CLOUDFLARE_API_TOKEN:-}${CLOUDFLARE_API_KEY:-}" ] ||
  die "a Cloudflare credential is set in the environment; this script logs in and out itself"

args=("$@")
i=0
while [ $i -lt ${#args[@]} ]; do
  act="${args[$i]}"
  case "$act" in
    deploy | deploy-bot | probe) i=$((i + 1)) ;;
    bucket-create | bucket-delete)
      [[ "${args[$((i + 1))]:-}" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || die "$act needs a bucket name"
      i=$((i + 2)) ;;
    secret-put)
      [[ "${args[$((i + 1))]:-}" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "secret-put needs an UPPER_SNAKE secret name"
      [[ "$SECRET_WORKERS" == *" ${args[$((i + 2))]:-} "* ]] || die "secret-put's Worker must be one of:$SECRET_WORKERS"
      i=$((i + 3)) ;;
    *) die "unknown act '$act' (no --name, no --env)" ;;
  esac
done

tested=""
probe_worker=""
probe_bucket=""

# The throwaway never outlives the login: the probe act calls this, and so does the trap.
probe_down() {
  local rc=0
  if [ -n "$probe_worker" ]; then w delete -c "$PROBE_CONFIG" --force && probe_worker="" || rc=1; fi
  if [ -n "$probe_bucket" ]; then w r2 bucket delete "$PROBE_BUCKET" && probe_bucket="" || rc=1; fi
  return $rc
}

end_session() {
  local rc=$?
  probe_down || rc=1
  w logout || rc=1
  exit $rc
}
trap end_session EXIT

run_tests() {
  if [ -z "$tested" ]; then
    (cd "$CF" && npm test </dev/null) || die "funes-cf's workerd tests failed; nothing deployed"
    tested=1
  fi
}

w login
set -- "${args[@]}"
while [ $# -gt 0 ]; do
  case "$1" in
    deploy)
      run_tests
      w deploy -c "$CF/wrangler.jsonc"
      shift ;;
    bucket-create)
      [ "$2" != "$PROBE_BUCKET" ] || probe_bucket=1
      w r2 bucket create "$2"
      shift 2 ;;
    bucket-delete)
      w r2 bucket delete "$2"
      [ "$2" != "$PROBE_BUCKET" ] || probe_bucket=""
      shift 2 ;;
    secret-put)
      value=""
      if [ -t 0 ]; then
        read -rs -p "cf-session: $2 for $3 (not echoed): " value
        echo >&2
      else
        IFS= read -r value || true
      fi
      [ -n "$value" ] || die "secret-put $2: no value on stdin"
      printf '%s' "$value" | "$WRANGLER" secret put "$2" --name "$3"
      value=""
      shift 3 ;;
    deploy-bot)
      [ -x "$BOT_DEPLOY" ] || die "no bot deploy script at $BOT_DEPLOY"
      "$BOT_DEPLOY" --in-session </dev/null
      shift ;;
    probe)
      run_tests
      bearer="$(openssl rand -hex 32)"
      probe_worker=1
      probe_bucket=1
      # Not `tee /dev/stderr`: on Linux that open fails (ENXIO) when stderr is a socket, as under Bun's spawn.
      deployed="$(w deploy -c "$PROBE_CONFIG")"
      printf '%s\n' "$deployed" >&2
      url="$(printf '%s\n' "$deployed" | grep -Eo 'https://funes-probe\.[a-z0-9-]+\.workers\.dev' | head -1)"
      printf '%s' "$bearer" | "$WRANGLER" secret put PROBE_BEARER -c "$PROBE_CONFIG"
      mkdir -p "$REPORTS"
      chmod 700 "$REPORTS"
      report="$REPORTS/probe-$(date -u +%Y%m%dT%H%M%SZ).json"
      # The header comes from stdin, so the bearer is on no argv. workers.dev can lag a fresh deploy.
      printf 'Authorization: Bearer %s\n' "$bearer" |
        curl -fsS --retry 6 --retry-all-errors --retry-delay 5 --max-time 900 -H @- "$url/" -o "$report"
      bearer=""
      echo "cf-session: probe report -> $report" >&2
      probe_down
      shift ;;
  esac
done
