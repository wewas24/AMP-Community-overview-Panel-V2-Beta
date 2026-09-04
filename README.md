# AMP Community Dashboard v2.1

AMP Community Dashboard v2.1 ist eine schnelle öffentliche Übersicht für AMP-Community-Seiten. AMP bleibt die vollständige Detail- und Verwaltungsansicht; das Dashboard bündelt Status, Links und Hinweise.

## Was neu ist

- Native, schnelle Serverkarten statt dauerhaft geladener Iframes.
- Die vollständige AMP-Community-Seite öffnet sich erst über **Details**.
- Kein automatischer Reload aller AMP-Seiten. Besucher stellen nur für die geöffnete Detailansicht eine Aktualisierung ein.
- SQLite-Speicher mit automatischer Übernahme der v1-JSON-Daten.
- Status-Queue mit begrenzter Parallelität, Fehlergründen, Statuscache, Historie und Uptime-Basis.
- Öffentliche versionierte API unter `/api/v1/public/servers`.
- Erweiterte Verwaltung: Tabs, Drag & Drop, Duplizieren, Verbindungstest, Branding, Links und Sichtbarkeiten.
- Schnelles Hinzufügen mit Name und AMP-Adresse; weitere Angaben bleiben optional aufklappbar.
- Verbindungsbutton auf Serverkarten: über einen eigenen Verbindungslink oder automatisch aus Spieladresse und Profil.
- Ein-Klick-Erkennung: Liest öffentliche Connect-Links und passende Spieladressen aus einer Community-Seite aus, ohne vorhandene Werte zu überschreiben.
- Community-Seiten derselben Internet-Adresse können bei Bedarf zusätzlich über ein kurzlebiges, unsichtbares Iframe geprüft werden. Fremde Iframes werden nie ausgelesen.
- Statusautomatik für Steam/Source, TeamSpeak und Minecraft Java sowie transparenter TCP-Fallback für weitere Server.
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

Beim ersten Start von v2 werden vorhandene `servers.json`, `settings.json`, Administratoren und das Änderungsprotokoll automatisch in `data/dashboard-v2.sqlite` übernommen. Zuvor kopiert die Anwendung die vorhandenen JSON-Dateien in einen datierten Unterordner von `data/backups/`.

Das Upgrade-Paket enthält bewusst keinen `data/`-Ordner. Dadurch werden vorhandene Server, Administratoren und Zugangsdaten nicht überschrieben.

Nach einem erfolgreichen Start wird die bisherige v1-Sitzung aus Sicherheitsgründen abgemeldet. Danach normal mit dem vorhandenen Administratorkonto anmelden.

## Sicherheit und Überwachung

Spielserver-Adressen werden standardmäßig gegen private und lokale Zielnetze geprüft. Für eine bewusst interne Installation kann in der Systemdienst-Datei diese Zeile ergänzt werden:

```ini
Environment=ALLOW_PRIVATE_NETWORKS=true
```

Danach den Systemdienst neu laden und neu starten. Diese Freigabe nur verwenden, wenn der Dashboard-Server interne Zieladressen tatsächlich überwachen darf.

Die automatische Prüfung benötigt keinen verpflichtenden Spieltyp. Das Profil **Automatisch** prüft Steam/Source, Minecraft Java und – bei passenden Ports – TeamSpeak. Steam/Source, TeamSpeak und Minecraft Java können zusätzliche Informationen wie Spielerzahl, Map oder Version liefern. Bei anderen Servern bleibt die umfassende AMP-Detailansicht die Informationsquelle.

## Community-Erkennung

In der Serververwaltung genügt die öffentliche AMP-Community-Adresse. Mit **Adresse automatisch ermitteln** versucht das Dashboard, einen öffentlichen Connect-Link sowie Host, Port und ein passendes Abfrageprofil zu übernehmen. Die Übernahme ist immer nur ein Vorschlag; bereits eingetragene Werte werden nicht verändert.

Die Erkennung funktioniert ohne AMP-Zugangsdaten. Sie kann daher nur Daten sehen, die die Community-Seite selbst öffentlich ausliefert. Nicht jede AMP-Anwendung besitzt ein standardisiertes Abfrageprotokoll oder einen Browser-Verbindungslink. In diesem Fall bleibt die Adresse manuell ergänzbar und der Status wird eindeutig erklärt.

## Daten und Backups

- `data/dashboard-v2.sqlite`: Konfiguration, Benutzer, Statusverlauf und Protokoll.
- `data/backups/`: Migrations- und Import-Sicherungen.
- Das Protokoll wird nach sieben Tagen bereinigt.
- Statushistorie wird nach 90 Tagen bereinigt.
- Exporte enthalten kein SMTP-Passwort.
