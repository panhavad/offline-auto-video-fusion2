#!/bin/sh
# ---------------------------------------------------------------------------
# auto-update - watch a git remote and redeploy the compose stack on new commits
#
# Runs as the "updater" compose service (profile: autoupdate). Every cycle it
# fetches the tracked branch, and when the remote moved forward it fast-forwards
# the checkout, rebuilds the image and restarts the service. The commit that was
# deployed successfully is remembered, so a failed build is retried on the next
# cycle instead of waiting for the next commit.
# ---------------------------------------------------------------------------
set -eu

REPO_DIR="${REPO_DIR:-/repo}"
UPDATE_REMOTE="${UPDATE_REMOTE:-origin}"
UPDATE_BRANCH="${UPDATE_BRANCH:-main}"
UPDATE_INTERVAL="${UPDATE_INTERVAL:-300}"
UPDATE_SERVICES="${UPDATE_SERVICES:-app}"
UPDATE_COMPOSE_FILE="${UPDATE_COMPOSE_FILE:-docker-compose.yml}"
UPDATE_PRUNE="${UPDATE_PRUNE:-true}"
UPDATE_FORCE_RESET="${UPDATE_FORCE_RESET:-false}"
UPDATE_DEPLOY_ON_START="${UPDATE_DEPLOY_ON_START:-false}"
UPDATE_ONCE="${UPDATE_ONCE:-false}"
# Resolved from the real git directory once the repository has been validated.
UPDATE_STATE_FILE="${UPDATE_STATE_FILE:-}"

log() { printf '%s [auto-update] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
warn() { log "WARN  $*" >&2; }
fail() { log "ERROR $*" >&2; }

is_true() {
	case "$(printf '%s' "${1:-}" | tr 'A-Z' 'a-z')" in
		1 | true | yes | on) return 0 ;;
		*) return 1 ;;
	esac
}

stop_requested=false
sleep_pid=''

on_signal() {
	stop_requested=true
	if [ -n "$sleep_pid" ]; then kill "$sleep_pid" 2>/dev/null || true; fi
	log "Stop requested; shutting down after the current step."
}
trap on_signal TERM INT

# A plain `sleep` would ignore SIGTERM until it expires, which makes
# `docker compose down` wait for the full interval.
nap() {
	sleep "$1" &
	sleep_pid=$!
	wait "$sleep_pid" 2>/dev/null || true
	sleep_pid=''
}

case "$UPDATE_COMPOSE_FILE" in
	/*) compose_file="$UPDATE_COMPOSE_FILE" ;;
	*) compose_file="$REPO_DIR/$UPDATE_COMPOSE_FILE" ;;
esac

compose() { docker compose --file "$compose_file" --project-directory "$REPO_DIR" "$@"; }

short() { printf '%s' "$1" | cut -c1-7; }

deploy() {
	commit="$1"
	log "Building $UPDATE_SERVICES at $(short "$commit")…"
	# Word splitting is intended: UPDATE_SERVICES may name several services.
	# shellcheck disable=SC2086
	compose build --pull $UPDATE_SERVICES || return 1
	log "Restarting $UPDATE_SERVICES…"
	# shellcheck disable=SC2086
	compose up -d $UPDATE_SERVICES || return 1
	printf '%s\n' "$commit" >"$UPDATE_STATE_FILE" 2>/dev/null ||
		warn "Could not write $UPDATE_STATE_FILE; the next cycle may redeploy the same commit."
	if is_true "$UPDATE_PRUNE"; then
		docker image prune --force >/dev/null 2>&1 ||
			warn "Could not prune replaced images."
	fi
	log "Deployed $(short "$commit")."
	return 0
}

cycle() {
	if ! git fetch --prune --quiet "$UPDATE_REMOTE" "$UPDATE_BRANCH"; then
		warn "Could not fetch $UPDATE_REMOTE/$UPDATE_BRANCH (unreachable remote, missing branch or missing credentials); retrying in ${UPDATE_INTERVAL}s."
		return 0
	fi

	target=$(git rev-parse --verify --quiet "refs/remotes/$UPDATE_REMOTE/$UPDATE_BRANCH") || target=''
	if [ -z "$target" ]; then
		warn "$UPDATE_REMOTE/$UPDATE_BRANCH does not exist; check UPDATE_REMOTE and UPDATE_BRANCH."
		return 0
	fi
	current=$(git rev-parse HEAD)
	deployed=$(cat "$UPDATE_STATE_FILE" 2>/dev/null || printf '')

	if [ "$current" = "$target" ] && [ "$target" = "$deployed" ]; then
		return 0
	fi

	# First start on an already up-to-date checkout: adopt the running deployment
	# instead of rebuilding it, unless a rebuild was explicitly asked for.
	if [ "$current" = "$target" ] && [ -z "$deployed" ] && ! is_true "$UPDATE_DEPLOY_ON_START"; then
		printf '%s\n' "$target" >"$UPDATE_STATE_FILE" 2>/dev/null || true
		log "Already on $UPDATE_REMOTE/$UPDATE_BRANCH at $(short "$target"); watching for new commits."
		return 0
	fi

	if [ "$current" != "$target" ]; then
		log "New commit on $UPDATE_REMOTE/$UPDATE_BRANCH: $(short "$current") → $(short "$target")"
		git --no-pager log --oneline --no-decorate "$current..$target" 2>/dev/null |
			head -n 10 | while IFS= read -r line; do log "  $line"; done

		if ! is_true "$UPDATE_FORCE_RESET"; then
			# Refuse to throw away work: local commits or real local edits stop the
			# update. Differences that are only CR/LF noise - what a checkout made on
			# Windows looks like to the Linux container - are not local work.
			if ! git merge-base --is-ancestor HEAD "$target"; then
				fail "$UPDATE_BRANCH has diverged from $UPDATE_REMOTE/$UPDATE_BRANCH and cannot be fast-forwarded. Set UPDATE_FORCE_RESET=true to overwrite it."
				return 0
			fi
			if ! git diff --quiet --ignore-cr-at-eol HEAD --; then
				warn "The checkout has local changes; skipping the update. Set UPDATE_FORCE_RESET=true to discard them:"
				git diff --name-only --ignore-cr-at-eol HEAD -- | head -n 10 |
					while IFS= read -r line; do warn "  $line"; done
				return 0
			fi
		fi
		if ! git checkout --quiet --force -B "$UPDATE_BRANCH" "$target"; then
			fail "Could not move $UPDATE_BRANCH to $(short "$target")."
			return 0
		fi
	else
		log "Retrying the deployment of $(short "$target")."
	fi

	if ! deploy "$target"; then
		fail "Deployment of $(short "$target") failed; the running container was left untouched. Retrying in ${UPDATE_INTERVAL}s."
	fi
	return 0
}

cd "$REPO_DIR" 2>/dev/null || {
	fail "$REPO_DIR is not available. Mount the checkout into the container."
	exit 1
}
# The checkout belongs to the host user, so git needs to be told it is safe.
git config --global --add safe.directory "$REPO_DIR"
git config --global --add safe.directory '*'

if ! git rev-parse --git-dir >/dev/null 2>&1; then
	fail "$REPO_DIR is not a git repository. Deploy from a clone for automatic updates to work."
	exit 1
fi
# Inside the git directory the marker survives restarts and is never committed.
[ -n "$UPDATE_STATE_FILE" ] || UPDATE_STATE_FILE="$(git rev-parse --absolute-git-dir)/auto-update-deployed"
if ! docker version >/dev/null 2>&1; then
	fail "The Docker daemon is not reachable. Mount /var/run/docker.sock into the container."
	exit 1
fi
if [ ! -f "$compose_file" ]; then
	fail "$compose_file does not exist."
	exit 1
fi

log "Watching $UPDATE_REMOTE/$UPDATE_BRANCH every ${UPDATE_INTERVAL}s; services: $UPDATE_SERVICES."
log "Repository: $(git config --get "remote.$UPDATE_REMOTE.url" 2>/dev/null || printf 'unknown')"

while :; do
	cycle || warn "The update cycle ended early; continuing."
	if is_true "$UPDATE_ONCE"; then
		log "UPDATE_ONCE is set; exiting after one cycle."
		break
	fi
	if [ "$stop_requested" = true ]; then break; fi
	nap "$UPDATE_INTERVAL"
	if [ "$stop_requested" = true ]; then break; fi
done

log "Stopped."
