#!/usr/bin/env bash
# Creates an isolated, loopback-only Phase-0 installation. It never modifies
# the production directory, its data directory, the production service, or nginx.
set -Eeuo pipefail

source_directory="${1:-/opt/amp-community-dashboard}"
stage_directory="${2:-/opt/amp-community-dashboard-phase0}"
server_count="${3:-250}"
port="${4:-3101}"
service_name="amp-community-dashboard-phase0-$server_count"

fail() { echo "FEHLER: $*" >&2; exit 1; }

[[ "$source_directory" == /* && "$stage_directory" == /* ]] || fail "Es sind absolute Ordnerpfade erforderlich."
[[ "$source_directory" != "$stage_directory" ]] || fail "Quell- und Testordner dürfen nicht identisch sein."
[[ -d "$source_directory" ]] || fail "Der Produktivordner wurde nicht gefunden: $source_directory"
[[ -f "$source_directory/server.mjs" ]] || fail "Die Quellanwendung ist unvollständig."
[[ -f "$source_directory/phase0/seed-synthetic.mjs" ]] || fail "Der Phase-0-Ordner fehlt im Produktivordner."
[[ "$server_count" =~ ^([1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|250)$ ]] || fail "Die Serveranzahl muss zwischen 1 und 250 liegen."
[[ "$port" =~ ^[0-9]{2,5}$ ]] && (( port >= 1024 && port <= 65535 )) || fail "Ungültiger lokaler Port."
[[ ! -e "$stage_directory" ]] || fail "Der Testordner existiert bereits und wird nicht überschrieben: $stage_directory"
id -u amp >/dev/null 2>&1 || fail "Der Systembenutzer 'amp' fehlt."
command -v node >/dev/null 2>&1 || fail "Node.js wurde nicht gefunden."
command -v curl >/dev/null 2>&1 || fail "curl wurde nicht gefunden."
if ss -ltn "sport = :$port" | grep -q LISTEN; then fail "Der lokale Port $port ist bereits belegt."; fi

echo "Erzeuge isolierte Phase-0-Testkopie mit $server_count synthetischen Servern …"
install -d -m 0755 "$stage_directory"
# Real data, backups, credentials, uploads and prior local dependencies are excluded.
tar -C "$source_directory" \
  --exclude='./data' --exclude='./node_modules' --exclude='./.git' \
  -cf - . | tar -C "$stage_directory" -xf -
install -d -o amp -g amp -m 0700 "$stage_directory/data"
chown -R amp:amp "$stage_directory"

runuser -u amp -- env DATA_DIRECTORY="$stage_directory/data" \
  node "$stage_directory/phase0/seed-synthetic.mjs" "$server_count"

sed \
  -e "s|__STAGE_DIRECTORY__|$stage_directory|g" \
  -e "s|__PORT__|$port|g" \
  "$stage_directory/phase0/amp-community-dashboard-phase0.service.template" \
  > "/etc/systemd/system/$service_name.service"

systemctl daemon-reload
systemctl start "$service_name"

for attempt in 1 2 3 4 5; do
  if curl --silent --show-error --fail "http://127.0.0.1:$port/health" >/dev/null; then
    echo
    echo "Testkopie bereit: http://127.0.0.1:$port"
    echo "Messung starten mit: bash $stage_directory/phase0/measure-api.sh $port"
    echo "Testdienst: $service_name.service"
    echo "Der Testdienst ist nicht öffentlich erreichbar und verändert keine Produktivdaten."
    exit 0
  fi
  sleep 1
done

systemctl status "$service_name" --no-pager || true
fail "Der Testdienst wurde nicht bereit. Die Produktivinstallation läuft unverändert weiter."
