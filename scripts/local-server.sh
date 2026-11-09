#!/usr/bin/env bash
# Run a local obscura-server and its backing services for the kit integration
# suites (`just kotlin-integration`, `just swift-integration`). CI calls this
# script too, so the local server matches the one the integration jobs use.
#
# Usage: scripts/local-server.sh ref|up [REF] | down | status | logs [LINES]
#
#   ref     Print the server commit that REF (default: HEAD) resolves to.
#   up      Build the server at REF if needed, start its services, then start
#           the server on http://localhost:3000 and wait until it is ready.
#   down    Stop everything `up` started and delete its data.
#   status  Report whether the server is running.
#   logs    Print the end of the server log.
#
# Environment:
#   OBSCURA_SERVER_SRC       Use this existing server checkout as-is instead of
#                            a managed clone. REF is then ignored.
#   OBSCURA_SERVER_SERVICES  How Postgres, Valkey and MinIO run:
#                            docker   - the server's own docker-compose.yml
#                            native   - local binaries (initdb, valkey-server, minio)
#                            external - already running; only create the bucket
#                            auto     - docker when the daemon is reachable,
#                                       else native (default)
#   OBSCURA_SERVER_CACHE     Clone, binary and runtime state
#                            (default: ~/.cache/obscura-server).
set -euo pipefail

SERVER_URL="https://github.com/obscura-messaging/obscura-server.git"
CACHE="${OBSCURA_SERVER_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/obscura-server}"
RUN="$CACHE/run"
COMPOSE_PROJECT="obscura-local"
API="http://localhost:3000"
BUCKET="test-bucket"

die() {
    echo "error: $*" >&2
    exit 1
}

log() {
    echo "==> $*" >&2
}

need() {
    local tool
    for tool in "$@"; do
        command -v "$tool" >/dev/null 2>&1 || die "$tool is required for $(services_mode) services"
    done
}

# GitHub occasionally drops clones and ls-remote calls from CI runners.
retry() {
    local attempt
    for attempt in 1 2 3; do
        if "$@"; then
            return 0
        fi
        if [[ "$attempt" -lt 3 ]]; then
            echo "retrying in 15s: $*" >&2
            sleep 15
        fi
    done
    return 1
}

port_in_use() {
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

wait_for() {
    local what="$1" seconds="$2"
    shift 2
    local i
    for ((i = 0; i < seconds; i++)); do
        if "$@" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    die "$what did not become ready within ${seconds}s"
}

services_mode() {
    local mode="${OBSCURA_SERVER_SERVICES:-auto}"
    case "$mode" in
        docker | native | external) echo "$mode" ;;
        auto)
            if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
                echo docker
            else
                echo native
            fi
            ;;
        *) die "OBSCURA_SERVER_SERVICES must be docker, native, external or auto (got '$mode')" ;;
    esac
}

resolve_ref() {
    local ref="${1:-HEAD}" sha
    if [[ -n "${OBSCURA_SERVER_SRC:-}" ]]; then
        git -C "$OBSCURA_SERVER_SRC" rev-parse HEAD
        return
    fi
    if [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then
        echo "$ref"
        return
    fi
    sha="$(retry git ls-remote "$SERVER_URL" "$ref" | awk 'NR == 1 { print $1 }')"
    [[ -n "$sha" ]] || die "could not resolve obscura-server ref '$ref'"
    echo "$sha"
}

# Sets SRC to a checkout of the server at $1.
fetch_source() {
    local sha="$1"
    if [[ -n "${OBSCURA_SERVER_SRC:-}" ]]; then
        SRC="$OBSCURA_SERVER_SRC"
        return
    fi
    SRC="$CACHE/src"
    if [[ "$(git -C "$SRC" rev-parse HEAD 2>/dev/null || true)" == "$sha" ]]; then
        return
    fi
    log "Fetching obscura-server $sha"
    mkdir -p "$SRC"
    git -C "$SRC" init -q
    git -C "$SRC" remote remove origin 2>/dev/null || true
    git -C "$SRC" remote add origin "$SERVER_URL"
    retry git -C "$SRC" fetch -q --depth 1 origin "$sha"
    git -C "$SRC" checkout -q --force FETCH_HEAD
    retry git -C "$SRC" submodule update -q --init --recursive
}

# Sets BIN to a server binary built from $1.
ensure_binary() {
    local sha="$1"
    if [[ -n "${OBSCURA_SERVER_SRC:-}" ]]; then
        fetch_source "$sha"
        command -v cargo >/dev/null 2>&1 || die "cargo is required to build obscura-server"
        log "Building obscura-server in $SRC"
        (cd "$SRC" && cargo build --release)
        BIN="$SRC/target/release/obscura-server"
        return
    fi
    BIN="$CACHE/bin/obscura-server"
    if [[ -x "$BIN" && "$(cat "$CACHE/bin/REF" 2>/dev/null || true)" == "$sha" ]]; then
        return
    fi
    fetch_source "$sha"
    command -v cargo >/dev/null 2>&1 || die "cargo (and protoc) are required to build obscura-server"
    log "Building obscura-server $sha"
    (cd "$SRC" && cargo build --release)
    mkdir -p "$CACHE/bin"
    cp "$SRC/target/release/obscura-server" "$BIN"
    echo "$sha" >"$CACHE/bin/REF"
}

pid_alive() {
    local file="$RUN/$1.pid"
    [[ -f "$file" ]] && kill -0 "$(cat "$file")" 2>/dev/null
}

stop_pid() {
    local file="$RUN/$1.pid" pid i
    [[ -f "$file" ]] || return 0
    pid="$(cat "$file")"
    if kill "$pid" 2>/dev/null; then
        for ((i = 0; i < 10; i++)); do
            kill -0 "$pid" 2>/dev/null || break
            sleep 1
        done
        kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$file"
}

require_free_ports() {
    local port busy=""
    for port in "$@"; do
        if port_in_use "$port"; then
            busy="$busy $port"
        fi
    done
    [[ -z "$busy" ]] || die "port(s)$busy already in use. Stop whatever holds them, or reuse running services with OBSCURA_SERVER_SERVICES=external"
}

compose() {
    docker compose -p "$COMPOSE_PROJECT" --project-directory "$SRC" -f "$SRC/docker-compose.yml" "$@"
}

start_docker_services() {
    log "Starting Postgres, Valkey and MinIO with docker compose"
    echo "$SRC" >"$RUN/compose-dir"
    compose up -d --wait db minio valkey
    # The image's healthcheck can pass on the init-time server, which only
    # listens on a socket; wait for TCP.
    compose exec -T db sh -c 'until pg_isready -h 127.0.0.1 -U user -d signal_server; do sleep 1; done'
}

find_pg_bin() {
    local dir
    if [[ -n "${OBSCURA_PG_BIN:-}" ]]; then
        echo "$OBSCURA_PG_BIN"
        return
    fi
    if command -v initdb >/dev/null 2>&1; then
        dirname "$(command -v initdb)"
        return
    fi
    if command -v brew >/dev/null 2>&1; then
        dir="$(brew --prefix postgresql@18 2>/dev/null || true)/bin"
        if [[ -x "$dir/initdb" ]]; then
            echo "$dir"
            return
        fi
    fi
    for dir in /usr/lib/postgresql/*/bin; do
        if [[ -x "$dir/initdb" ]]; then
            echo "$dir"
            return
        fi
    done
    die "Postgres binaries (initdb, pg_ctl) not found; set OBSCURA_PG_BIN or install postgresql@18"
}

start_native_services() {
    local pg
    pg="$(find_pg_bin)"
    log "Starting Postgres, Valkey and MinIO natively in $RUN"

    if ! "$pg/pg_ctl" -D "$RUN/pgdata" status >/dev/null 2>&1; then
        if [[ ! -d "$RUN/pgdata" ]]; then
            "$pg/initdb" -D "$RUN/pgdata" -U user --auth=trust >"$RUN/initdb.log"
            "$pg/pg_ctl" -D "$RUN/pgdata" -l "$RUN/pg.log" -o "-k '$RUN' -h 127.0.0.1 -p 5432" -w start >/dev/null
            "$pg/createdb" -h 127.0.0.1 -U user signal_server
        else
            "$pg/pg_ctl" -D "$RUN/pgdata" -l "$RUN/pg.log" -o "-k '$RUN' -h 127.0.0.1 -p 5432" -w start >/dev/null
        fi
    fi

    if ! pid_alive valkey; then
        valkey-server --daemonize yes --port 6379 --dir "$RUN" \
            --pidfile "$RUN/valkey.pid" --logfile "$RUN/valkey.log"
        wait_for "Valkey" 30 valkey-cli -p 6379 ping
    fi

    if ! pid_alive minio; then
        MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
            nohup minio server "$RUN/minio" --address :9000 </dev/null >"$RUN/minio.log" 2>&1 &
        echo $! >"$RUN/minio.pid"
    fi
    wait_for "MinIO" 30 curl -fsS http://localhost:9000/minio/health/live
}

ensure_bucket() {
    local aws
    export AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin AWS_DEFAULT_REGION=us-east-1
    if command -v aws >/dev/null 2>&1; then
        aws=(aws)
    elif command -v docker >/dev/null 2>&1; then
        aws=(docker run --rm --network host -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION amazon/aws-cli)
    else
        die "the AWS CLI (or docker) is required to create the MinIO bucket"
    fi
    if ! "${aws[@]}" --endpoint-url http://localhost:9000 s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
        "${aws[@]}" --endpoint-url http://localhost:9000 s3api create-bucket --bucket "$BUCKET" >/dev/null
    fi
}

server_ready() {
    curl -fs -o /dev/null "$API/openapi.yaml"
}

start_server() {
    local i
    stop_pid server
    log "Starting obscura-server"
    (
        cd "$RUN"
        export OBSCURA_DATABASE_URL="postgres://user:password@localhost:5432/signal_server"
        export OBSCURA_PUBSUB_URL="redis://localhost:6379"
        export OBSCURA_AUTH_JWT_SECRET="test_secret"
        export OBSCURA_STORAGE_BUCKET="$BUCKET"
        export OBSCURA_STORAGE_ENDPOINT="http://localhost:9000"
        export OBSCURA_STORAGE_ACCESS_KEY="minioadmin"
        export OBSCURA_STORAGE_SECRET_KEY="minioadmin"
        export OBSCURA_STORAGE_FORCE_PATH_STYLE="true"
        export OBSCURA_RATE_LIMIT_PER_SECOND=1000
        export OBSCURA_RATE_LIMIT_BURST=2000
        export OBSCURA_RATE_LIMIT_AUTH_PER_SECOND=1000
        export OBSCURA_RATE_LIMIT_AUTH_BURST=2000
        export RUST_LOG="${RUST_LOG:-info}"
        nohup "$BIN" </dev/null >"$RUN/server.log" 2>&1 &
        echo $! >"$RUN/server.pid"
    )
    for ((i = 0; i < 60; i++)); do
        if server_ready; then
            return 0
        fi
        if ! pid_alive server; then
            tail -n 100 "$RUN/server.log" >&2
            die "obscura-server exited during startup"
        fi
        sleep 1
    done
    tail -n 100 "$RUN/server.log" >&2
    die "obscura-server did not become ready within 60s"
}

cleanup_failed_up() {
    local status=$?
    if [[ "$status" -ne 0 ]]; then
        if [[ -f "$RUN/server.log" ]]; then
            cp "$RUN/server.log" "$CACHE/failed-server.log"
            log "up failed; server log kept at $CACHE/failed-server.log"
        fi
        cmd_down >/dev/null 2>&1 || true
    fi
}

# Fail before a long build when another process holds a port `up` needs.
# Ports held by this script's own earlier `up` are fine.
preflight() {
    local mode="$1" ports=() pg
    pid_alive server || ports+=(3000)
    case "$mode" in
        docker)
            command -v docker >/dev/null 2>&1 || die "docker is required for docker services"
            if [[ -z "$(docker compose -p "$COMPOSE_PROJECT" ps -q 2>/dev/null)" ]]; then
                ports+=(5432 6379 9000)
            fi
            ;;
        native)
            pg="$(find_pg_bin)"
            need valkey-server valkey-cli minio curl
            "$pg/pg_ctl" -D "$RUN/pgdata" status >/dev/null 2>&1 || ports+=(5432)
            pid_alive valkey || ports+=(6379)
            pid_alive minio || ports+=(9000)
            ;;
        external) ;;
    esac
    if [[ ${#ports[@]} -gt 0 ]]; then
        require_free_ports "${ports[@]}"
    fi
}

cmd_up() {
    local sha mode
    sha="$(resolve_ref "${1:-}")"
    mode="$(services_mode)"
    if [[ -f "$RUN/mode" && "$(cat "$RUN/mode")" != "$mode" ]]; then
        die "services are already running in $(cat "$RUN/mode") mode; run 'just server-down' first"
    fi
    preflight "$mode"
    ensure_binary "$sha"
    if [[ ! -d "$RUN" ]]; then
        # A failed first start must not leave state that blocks the next one.
        trap cleanup_failed_up EXIT
    fi
    mkdir -p "$RUN"
    echo "$mode" >"$RUN/mode"
    case "$mode" in
        docker)
            fetch_source "$sha"
            start_docker_services
            ;;
        native) start_native_services ;;
        external) log "Using already-running Postgres, Valkey and MinIO" ;;
    esac
    ensure_bucket
    start_server
    echo "$sha" >"$RUN/REF"
    log "obscura-server ${sha:0:12} ready at $API ($mode services)"
    log "Run: just kotlin-integration  |  just swift-integration  |  just server-down"
}

cmd_down() {
    local mode pg
    [[ -d "$RUN" ]] || {
        echo "Nothing to stop."
        return 0
    }
    mode="$(cat "$RUN/mode" 2>/dev/null || echo external)"
    stop_pid server
    case "$mode" in
        docker)
            SRC="$(cat "$RUN/compose-dir" 2>/dev/null || true)"
            if [[ -n "$SRC" && -f "$SRC/docker-compose.yml" ]]; then
                compose down -v --remove-orphans
            else
                docker compose -p "$COMPOSE_PROJECT" down -v --remove-orphans
            fi
            ;;
        native)
            stop_pid minio
            stop_pid valkey
            if [[ -d "$RUN/pgdata" ]]; then
                pg="$(find_pg_bin)"
                "$pg/pg_ctl" -D "$RUN/pgdata" -m immediate stop >/dev/null 2>&1 || true
            fi
            ;;
        external) ;;
    esac
    rm -rf "${RUN:?}"
    echo "Stopped obscura-server ($mode services)."
}

cmd_status() {
    if server_ready 2>/dev/null; then
        if pid_alive server; then
            echo "obscura-server $(cut -c1-12 "$RUN/REF" 2>/dev/null || echo '?') running at $API ($(cat "$RUN/mode") services)"
        else
            echo "A server not started by this script is answering at $API"
        fi
    else
        echo "No server at $API"
        return 1
    fi
}

cmd_logs() {
    [[ -f "$RUN/server.log" ]] || die "no server log at $RUN/server.log"
    tail -n "${1:-200}" "$RUN/server.log"
}

case "${1:-}" in
    ref) resolve_ref "${2:-}" ;;
    up) cmd_up "${2:-}" ;;
    down) cmd_down ;;
    status) cmd_status ;;
    logs) cmd_logs "${2:-}" ;;
    *)
        sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//' >&2
        exit 2
        ;;
esac
