# AMP Community Dashboard v2.0

AMP Community Dashboard v2.0 ist eine schnelle öffentliche Übersicht für AMP-Community-Seiten. AMP bleibt die vollständige Detail- und Verwaltungsansicht; das Dashboard bündelt Status, Links und Hinweise.

## Was neu ist

- Native, schnelle Serverkarten statt dauerhaft geladener Iframes.
- Die vollständige AMP-Community-Seite öffnet sich erst über **Details**.
- Kein automatischer Reload aller AMP-Seiten. Besucher stellen nur für die geöffnete Detailansicht eine Aktualisierung ein.
- SQLite-Speicher mit automatischer Übernahme der v1-JSON-Daten.
- Status-Queue mit begrenzter Parallelität, Fehlergründen, Statuscache, Historie und Uptime-Basis.
- Öffentliche versionierte API unter `/api/v1/public/servers`.
- Erweiterte Verwaltung: Tabs, Drag & Drop, Duplizieren, Verbindungstest, Branding, Links und Sichtbarkeiten.
- Automatisches Backup vor einem Import und schema-versionierte Exporte.
- E-Mail-Benachrichtigungen über SMTP mit STARTTLS.

## Voraussetzungen

- Node.js 22 oder neuer.
- Nginx als HTTPS-Reverse-Proxy.
- AMP Community-Seiten mit öffentlichen HTTPS-Adressen.

Es werden keine zusätzlichen npm-Pakete benötigt. SQLite ist in der unterstützten Node.js-Laufzeit enthalten.

## Neue Installation

1. Den Ordner nach `/opt/amp-community-dashboard` kopieren.
2. Einen Administrator mit `node create-admin.mjs` erstellen.
3. Den Systemdienst starten.
4. Den Nginx-Abschnitt aus `nginx-snippet.conf` in den vorhandenen HTTPS-Serverblock einfügen.

Die Anwendung hört ausschließlich auf `127.0.0.1:3100`. Ein Beispiel für die öffentliche Adresse lautet:

`https://amp.example.com/uebersicht/`

## Upgrade von v1

Beim ersten Start von v2.0 werden vorhandene `servers.json`, `settings.json`, Administratoren und das Änderungsprotokoll automatisch in `data/dashboard-v2.sqlite` übernommen. Zuvor kopiert die Anwendung die vorhandenen JSON-Dateien in einen datierten Unterordner von `data/backups/`.

Das Upgrade-Paket enthält bewusst keinen `data/`-Ordner. Dadurch werden vorhandene Server, Administratoren und Zugangsdaten nicht überschrieben.

Nach einem erfolgreichen Start wird die bisherige v1-Sitzung aus Sicherheitsgründen abgemeldet. Danach normal mit dem vorhandenen Administratorkonto anmelden.

## Sicherheit und Überwachung

Spielserver-Adressen werden standardmäßig gegen private und lokale Zielnetze geprüft. Für eine bewusst interne Installation kann in der Systemdienst-Datei diese Zeile ergänzt werden:

```ini
Environment=ALLOW_PRIVATE_NETWORKS=true
```

Danach den Systemdienst neu laden und neu starten. Diese Freigabe nur verwenden, wenn der Dashboard-Server interne Zieladressen tatsächlich überwachen darf.

Die automatische Prüfung benötigt keinen verpflichtenden Spieltyp. Das Profil **Automatisch** prüft die allgemein verfügbaren Schnittstellen; Steam/Source und TeamSpeak können zusätzliche Informationen wie Spielerzahl, Map oder Version liefern. Bei anderen Servern bleibt die umfassende AMP-Detailansicht die Informationsquelle.

## Daten und Backups

- `data/dashboard-v2.sqlite`: Konfiguration, Benutzer, Statusverlauf und Protokoll.
- `data/backups/`: Migrations- und Import-Sicherungen.
- Das Protokoll wird nach sieben Tagen bereinigt.
- Statushistorie wird nach 90 Tagen bereinigt.
- Exporte enthalten kein SMTP-Passwort.
