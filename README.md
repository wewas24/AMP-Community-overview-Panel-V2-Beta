# AMP Community Dashboard v2.3.0

Eine öffentliche Übersicht für AMP-Community-Seiten. Die AMP-Seite bleibt die vollständige Detailansicht; das Dashboard bündelt Status, Hinweise, Health-Werte und bewusst freigegebene Verbindungslinks.

## Funktionen

- Live-Aktualisierung mit Server-Sent Events (SSE), ohne Browser-Polling von Spielservern.
- Öffentliche versionierte API: `GET /api/v1/public/servers`, `GET /api/v1/public/metrics` und `GET /api/v1/public/events`.
- Gesundheitswert, Uptime und Latenzdiagramm pro Server. Statuswechsel und Messwerte werden getrennt und platzsparend gespeichert.
- Eigene Community-URL, Spielserver-Verbindung und optionale Monitoring-Adresse je Server.
- Adapter für TCP, Steam/Source, Minecraft Java und TeamSpeak; bei `Automatisch` werden passende sichere Abfragen ausprobiert.
- Detailansicht der AMP-Community-Seite in einem erst nach Klick geladenen Iframe.
- Servergruppen mit Besucherfilter, Kategorien und Sortierung.
- Sichere Banner-Uploads (PNG, JPEG, WebP bis 2 MB), helles/dunkles Design und installierbare PWA für Mobilgeräte.
- SMTP mit STARTTLS, bis zu fünf sichere HTTPS-Webhooks (z. B. Discord), Meldungen bei Statuswechseln, hoher Latenz und längerem Ausfall.
- Bereits vorhandene Konten, Server und Daten bleiben beim Update erhalten.

## Einfache Bedienung in v2.3

- Die Verwaltung startet im einfachen Modus: sichtbar sind nur Dashboard, Server, Benachrichtigungen und Einstellungen.
- Einen Server legst du mit Name, AMP-Community-Adresse, „Server erkennen“ und „Speichern“ an. Spielserver-, Monitoring- und Protokollangaben sind unter „Erweiterte Einstellungen“ verborgen.
- Serverkarten zeigen im Standard nur Status, Spieler, Latenz und klare Aktionen „Öffnen“ und „Details“. Health-Werte, Diagramme und technische Hinweise erscheinen nur im erweiterten Modus.
- Einstellungen bündeln Allgemein, Benutzer, Berechtigungen, Änderungsprotokoll, Sicherungen und Systemstatus. Nicht berechtigte Bereiche werden nicht angezeigt.
- Rollen heißen Administrator, Moderator, Support, Nur ansehen oder Benutzerdefiniert. Jede Berechtigung wird weiterhin auf dem Server geprüft.
- Beim ersten leeren Dashboard erscheint ein überspringbarer Schnellstart-Assistent.

## Voraussetzungen

- Node.js 22 oder neuer
- Nginx als HTTPS-Reverse-Proxy
- öffentliche HTTPS-Adressen für AMP-Community-Seiten

Es werden keine zusätzlichen npm-Pakete benötigt.

## Sicherheitsmodell

- Öffentliche Antworten enthalten keine Monitoring-Adresse, Spielserver-IP, Ports oder Prüfprofile. Ein Verbindungsbutton wird nur nach bewusster Freigabe je Server angezeigt.
- Community-, Monitoring-, SMTP- und Webhook-Ziele werden bei jeder Verbindung per DNS aufgelöst, auf öffentliche IPv4-/IPv6-Netze geprüft und anschließend an die geprüfte IP gebunden. Redirects bei der Community-Erkennung sind blockiert.
- Iframe-, Bild-, Link- und Webhook-Adressen müssen HTTPS ohne Zugangsdaten nutzen. Webhooks sind auf Port 443 begrenzt.
- Das Monitoring läuft ausschließlich zeitgesteuert im Serverprozess oder nach einem berechtigten manuellen Test. Ein Seitenaufruf startet niemals eine Prüfung.
- Das SMTP-Passwort und Webhook-Adressen liegen nur in `data/secrets/`, nicht in SQLite, Exporten oder neuen Backups.
- Sitzungen verwenden CSRF-Tokens, sichere `__Host-`-Cookies unter HTTPS und eine persistente Anmeldedrosselung.
- Statusdaten werden als „veraltet“ markiert, sobald keine frische Überwachung mehr vorliegt.

## Neue Installation

1. Paket nach `/opt/amp-community-dashboard` entpacken und das Dienstkonto einrichten:

   ```bash
   sudo mkdir -p /opt/amp-community-dashboard
   sudo unzip /opt/amp-community-dashboard-v2.3.0-simple-ui.zip -d /opt/amp-community-dashboard
   sudo useradd --system --home /opt/amp-community-dashboard --shell /usr/sbin/nologin amp 2>/dev/null || true
   sudo chown -R amp:amp /opt/amp-community-dashboard
   ```

2. Erstes Konto anlegen:

   ```bash
   cd /opt/amp-community-dashboard
   sudo -u amp node create-admin.mjs
   ```

3. Dienst aktivieren:

   ```bash
   sudo cp amp-community-dashboard.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now amp-community-dashboard
   ```

4. `nginx-security-http.conf` im globalen Nginx-`http {}`-Bereich einbinden. Den Inhalt von `nginx-snippet.conf` in den vorhandenen HTTPS-`server {}`-Block der AMP-Domain einfügen. Der vorhandene AMP-Block `location /` bleibt unverändert.

5. Nginx prüfen und neu laden:

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

Die Übersicht ist dann beispielsweise unter `https://amp.example.com/uebersicht/` verfügbar.

## Update auf v2.3.0

1. Dienst stoppen und den vollständigen bisherigen Ordner sichern:

   ```bash
   sudo systemctl stop amp-community-dashboard
   sudo cp -a /opt/amp-community-dashboard /opt/amp-community-dashboard-before-v2.3.0
   ```

2. Das Paket in einen temporären Ordner entpacken. Anschließend alle Dateien **außer** `data/` in den bestehenden Projektordner kopieren. `data/` weder löschen noch überschreiben.

   ```bash
   sudo mkdir -p /opt/amp-dashboard-update
   sudo unzip -o /opt/amp-community-dashboard-v2.3.0-simple-ui.zip -d /opt/amp-dashboard-update
   sudo rsync -a --exclude=data/ /opt/amp-dashboard-update/ /opt/amp-community-dashboard/
   sudo chown -R amp:amp /opt/amp-community-dashboard
   ```

3. Die neue Dienstdatei übernehmen. Den aktuellen Inhalt von `nginx-snippet.conf` in den bestehenden HTTPS-Serverblock kopieren; die unbuffered Proxy-Einstellungen sind für Live-Updates erforderlich.

4. Starten und prüfen:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart amp-community-dashboard
   sudo systemctl status amp-community-dashboard --no-pager
   curl -fsS http://127.0.0.1:3100/health
   ```

Der erste Start ergänzt die Datenbanktabellen automatisch. Bestehende V2-Daten und die ursprünglichen V1-Dateien bleiben unverändert. Alte Sitzungen können zur Sicherheit abgemeldet werden.

## V1-Migration: Backup → Dry Run → Migration → Validierung → Rollback

Für eine reine V1-Installation zuerst im Projektordner prüfen:

```bash
sudo -u amp node migrate-v1.mjs
```

Erst wenn Anzahl und Fundstellen stimmen, die Migration ausführen:

```bash
sudo -u amp node migrate-v1.mjs --apply
```

Das Werkzeug erstellt vorab ein Backup der V1-Dateien, validiert danach die übernommene Serveranzahl und verschiebt eine fehlgeschlagene neue Datenbank in das Backup. Die V1-Originaldateien werden nie verändert.

## Betrieb

- Die Anwendung lauscht standardmäßig nur auf `127.0.0.1:3100`. Öffentlicher Zugriff erfolgt ausschließlich per HTTPS über Nginx.
- Private Spielserverziele sind standardmäßig blockiert. Für eine bewusst interne Installation kann in der Dienstdatei `Environment=ALLOW_PRIVATE_NETWORKS=true` gesetzt werden. Das nur in einem vertrauenswürdigen Netz verwenden.
- StartTLS-SMTP-Ports sind standardmäßig `25`, `587` und `2525`; Community-Seiten `443` und `8443`.
- `GET /health` zeigt den Prozesszustand. `GET /ready` zeigt zusätzlich, ob Datenbank und Monitoring bereit sind.
- `data/`, insbesondere `data/secrets/`, `data/uploads/` und `data/backups/`, liegt außerhalb des Webroots und darf nie direkt durch Nginx ausgeliefert werden.
- Die PWA kann über die Browserfunktion „App installieren“ auf Mobilgeräten abgelegt werden. Sie ist eine installierbare Web-App, keine native Store-App.

## Rechte

- **Vollzugriff:** Einstellungen, Tests, automatische Erkennung, Zugänge, Sicherungen, Webhooks und Protokollexport.
- **Serververwaltung:** Server anlegen, bearbeiten, sortieren und löschen; keine Netzwerk-Tests oder Änderungen an Spielserver-Endpunkten.
- **Protokoll ansehen:** nur die letzten Audit-Einträge.
