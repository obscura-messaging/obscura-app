#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${JAVA_HOME:-}" ]]; then
  case "$(uname -s)" in
    Darwin)
      JAVA_HOME="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
      ;;
    Linux)
      if command -v java >/dev/null 2>&1; then
        JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")"
      fi
      ;;
  esac
  export JAVA_HOME
fi

if [[ -z "${JAVA_HOME:-}" || ! -x "$JAVA_HOME/bin/java" ]]; then
  echo "error: JDK 21 is required; set JAVA_HOME to a JDK 21 installation" >&2
  exit 1
fi

version="$("$JAVA_HOME/bin/java" -version 2>&1 | awk -F '"' '/version/ { print $2; exit }')"
major="${version%%.*}"
if [[ "$major" != "21" ]]; then
  echo "error: JDK 21 is required; JAVA_HOME provides Java $version" >&2
  exit 1
fi

exec "$@"
