#!/usr/bin/env bash
# Local Phase-0 HTTP benchmark. It targets the isolated loopback test service only.
set -Eeuo pipefail

port="${1:-3101}"
base_url="http://127.0.0.1:$port"
work_directory="$(mktemp -d)"
trap 'rm -rf "$work_directory"' EXIT

command -v curl >/dev/null 2>&1 || { echo "curl fehlt." >&2; exit 1; }
curl --silent --show-error --fail "$base_url/health" >/dev/null || { echo "Der Phase-0-Testdienst auf Port $port ist nicht erreichbar." >&2; exit 1; }

measure_endpoint() {
  local endpoint="$1"
  local output="$work_directory/$(echo "$endpoint" | tr '/' '_').txt"
  : > "$output"
  for run in $(seq 1 10); do
    curl --silent --show-error --output /dev/null \
      --write-out '%{http_code} %{time_total} %{size_download}\n' \
      "$base_url$endpoint" >> "$output"
  done
  awk -v endpoint="$endpoint" '
    { sum += $2; if (NR == 1 || $2 < min) min = $2; if ($2 > max) max = $2; bytes = $3; codes[$1]++ }
    END { printf "%s | %d Aufrufe | Ø %.2f ms | Min %.2f ms | Max %.2f ms | %d Bytes | HTTP", endpoint, NR, sum / NR * 1000, min * 1000, max * 1000, bytes; for (code in codes) printf " %s:%d", code, codes[code]; print "" }
  ' "$output"
}

measure_parallel_initial_load() {
  local clients="$1"
  local mode="$2"
  local output="$work_directory/clients-$clients.txt"
  local started ended elapsed_ms
  : > "$output"
  started=$(date +%s%N)
  for client in $(seq 1 "$clients"); do
    (
      curl --silent --show-error --output /dev/null --write-out '%{http_code} %{time_total} %{size_download}\n' "$base_url/api/v1/public/servers"
      if [[ "$mode" == "advanced" ]]; then
        curl --silent --show-error --output /dev/null --write-out '%{http_code} %{time_total} %{size_download}\n' "$base_url/api/v1/public/metrics"
      fi
    ) >> "$output" &
  done
  wait
  ended=$(date +%s%N)
  elapsed_ms=$(( (ended - started) / 1000000 ))
  awk -v clients="$clients" -v elapsed="$elapsed_ms" -v mode="$mode" '
    { sum += $2; if (NR == 1 || $2 < min) min = $2; if ($2 > max) max = $2; bytes += $3; codes[$1]++ }
    END { printf "%d parallele Besucher (%s) | %d HTTP-Aufrufe | Gesamt %d ms | Ø %.2f ms | Min %.2f ms | Max %.2f ms | Summe %d Bytes | HTTP", clients, mode, NR, elapsed, sum / NR * 1000, min * 1000, max * 1000, bytes; for (code in codes) printf " %s:%d", code, codes[code]; print "" }
  ' "$output"
}

measure_sse() {
  echo
  echo "SSE über 40 Sekunden (der Testmonitor kontaktiert keine externen Ziele):"
  node "$(dirname "$0")/measure-sse.mjs" "$base_url"
}

echo "Phase-0-HTTP-Messung gegen $base_url"
echo "Einzelaufrufe:"
measure_endpoint "/health"
measure_endpoint "/api/v1/public/servers"
measure_endpoint "/api/v1/public/metrics"
echo
echo "Gleichzeitige anfängliche Ladevorgänge (einfach = nur Übersicht; erweitert = Übersicht + Diagrammdaten):"
measure_parallel_initial_load 1 simple
measure_parallel_initial_load 10 simple
measure_parallel_initial_load 50 simple
measure_parallel_initial_load 100 simple
measure_parallel_initial_load 100 advanced
measure_parallel_initial_load 250 simple
measure_parallel_initial_load 250 advanced
measure_sse
