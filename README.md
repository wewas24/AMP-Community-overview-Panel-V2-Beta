# AMP Community Dashboard v2.1.1

Eine öffentliche, schnelle Übersicht für AMP-Community-Seiten. AMP bleibt die vollständige Detailansicht; das Dashboard zeigt Status, Hinweise und bewusst freigegebene Verbindungslinks gesammelt an.

## Voraussetzungen

- Node.js 22 oder neuer
- Nginx als HTTPS-Reverse-Proxy
- Öffentliche HTTPS-Adressen für AMP-Community-Seiten

Es werden keine zusätzlichen npm-Pakete benötigt.

## Sicherheitsstand v2.1.1

- Öffentliche API-Antworten enthalten keine internen Spielserver-Adressen, Ports oder Prüfprofile.
- Ein Verbindungsbutton ist je Server eine bewusste Freigabe. Ohne diese Option bleibt die Spieladresse privat.
- Ausgehende Community-, Monitoring- und SMTP-Verbindungen lösen DNS direkt vor der Verbindung auf, prüfen dabei öffentliche IPv4-/IPv6-Netze und verbinden anschließend nur zur geprüften IP-Adresse.
- Redirects von Community-Seiten sind bei der automatischen Erkennung blockiert. Community- und SMTP-Ports sind auf eine kleine, konfigurierbare Liste begrenzt.
- SMTP nutzt ausschließlich STARTTLS, prüft Zertifikate und begrenzt Antwort- sowie Nachrichtengrößen.
- Das SMTP-Passwort liegt nicht mehr in SQLite, Backups oder Exporten, sondern nur in `data/secrets/smtp-password` mit restriktiven Dateirechten.
- Sitzungen haben zufällige CSRF-Tokens. Jede schreibende Aktion, auch Export und Logout, benötigt denselben Origin und diesen Token.
- Der Cookie ist unter HTTPS ein `__Host-`-Cookie mit `Secure`, `HttpOnly` und `SameSite=Strict`.
- Login-Drosselung ist persistent, unabhängig für IP und Benutzername, und das Passwort wird asynchron mit Scrypt geprüft.
- Audit-Einträge sind nach dem Schreiben unveränderbar, werden nach sieben Tagen bereinigt und enthalten keine Zugangsdaten oder Spielserver-Endpunkte.

## Neue Installation

1. Ordner nach `/opt/amp-community-dashboard` kopieren und dem Dienstkonto zuordnen.
2. Das Dienstkonto `amp` anlegen, falls es noch nicht existiert.
3. Erstes Konto im Projektordner erstellen:

   ```bash
   sudo -u amp node create-admin.mjs
   ```

4. `amp-community-dashboard.service` nach `/etc/systemd/system/` kopieren, dann aktivieren:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now amp-community-dashboard
   ```

5. `nginx-security-http.conf` im `http {}`-Bereich einbinden, zum Beispiel als Datei `/etc/nginx/conf.d/amp-dashboard-security-http.conf`.
6. Den Inhalt von `nginx-snippet.conf` in den vorhandenen HTTPS-`server {}`-Block der AMP-Domain einfügen. Die AMP-Konfiguration für `/` bleibt unverändert.
7. Konfiguration prüfen und Nginx neu laden:

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

Die öffentliche Adresse kann beispielsweise so aussehen: `https://amp.example.com/uebersicht/`.

## Update auf v2.1.1

1. Dienst stoppen und eine Sicherung des bisherigen Projektordners erstellen:

   ```bash
   sudo systemctl stop amp-community-dashboard
   sudo cp -a /opt/amp-community-dashboard /opt/amp-community-dashboard-before-v2.1.1
   ```

2. Alle Dateien aus dem Update-Paket nach `/opt/amp-community-dashboard` kopieren. Den vorhandenen Ordner `data/` nicht ersetzen oder löschen.
3. Die neue Dienstdatei und beide Nginx-Dateien gemäß den Schritten 4–7 der Installation übernehmen.
4. Dateibesitzer setzen und starten:

   ```bash
   sudo chown -R amp:amp /opt/amp-community-dashboard
   sudo systemctl daemon-reload
   sudo systemctl restart amp-community-dashboard
   sudo systemctl status amp-community-dashboard --no-pager
   ```

Beim ersten Start werden alle bisherigen Sitzungen absichtlich abgemeldet. Das bisherige SMTP-Passwort wird aus SQLite in die geschützte Secret-Datei verschoben und aus der Konfiguration entfernt.

## Betriebshinweise

- Die Anwendung lauscht standardmäßig nur auf `127.0.0.1:3100`. `HOST=0.0.0.0` wird nur mit der ausdrücklichen Variable `ALLOW_PUBLIC_BIND=true` akzeptiert; das ist für den normalen Betrieb nicht vorgesehen.
- Private Spielserverziele bleiben standardmäßig gesperrt. Für eine bewusst interne Installation kann `Environment=ALLOW_PRIVATE_NETWORKS=true` in der Dienstdatei gesetzt werden. Diese Freigabe nur in vertrauenswürdigen Netzen verwenden.
- Standardmäßig sind Community-Ports `443,8443` und SMTP-Ports `25,587,2525` erlaubt. Falls nötig, können sie über `COMMUNITY_ALLOWED_PORTS` bzw. `SMTP_ALLOWED_PORTS` im Dienst kontrolliert erweitert werden.
- Der StartTLS-Test ist absichtlich nur für die erlaubten SMTP-Ports verfügbar; er ist kein allgemeiner Verbindungstest.
- `data/`, besonders `data/backups/` und `data/secrets/`, muss außerhalb des Webroots bleiben. Die mitgelieferte Anwendung stellt ausschließlich `public/` bereit.

## Daten und Backups

- `data/dashboard-v2.sqlite`: Konfiguration, Konten, Statushistorie und Audit-Protokoll
- `data/secrets/smtp-password`: SMTP-Geheimnis, nicht in SQLite und nicht in Exporten
- `data/backups/`: automatische Sicherungen vor Importen
- Audit-Protokoll: sieben Tage Aufbewahrung
- Statushistorie: 90 Tage Aufbewahrung

## Rechte

- **Vollzugriff**: Einstellungen, Tests, Erkennung, Zugänge, Sicherungen und Protokoll-Export
- **Serververwaltung**: Server anlegen, bearbeiten, sortieren und löschen; keine Netzwerk-Tests oder automatische Erkennung
- **Protokoll ansehen**: nur die letzten Audit-Einträge

Die Detailansicht lädt die originale AMP-Community-Seite erst nach einem Klick auf **Details**. Besucher können deren Aktualisierungsintervall individuell einstellen.
