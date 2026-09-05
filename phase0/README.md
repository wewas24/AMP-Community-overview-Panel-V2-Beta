# Phase 0 – isolierte Leistungsbasis

Diese Werkzeuge erzeugen eine vollständig getrennte Testkopie der Anwendung. Sie kopieren weder die produktive `data`-Struktur noch Sicherungen, Uploads, Zugangsdaten oder Konfigurationen. Der Testdienst lauscht ausschließlich auf `127.0.0.1` und wird nicht durch nginx veröffentlicht.

## Vorbereitung auf dem VPS

1. Den gesamten Ordner `phase0` in den Produktivordner der Anwendung kopieren. Die Produktivdateien und der Dienst werden dadurch nicht neu gestartet oder verändert.
2. Eine Testgröße wählen: `10`, `50`, `100` oder `250`.
3. Als Administrator ausführen:

```bash
bash /opt/amp-community-dashboard/phase0/setup-staging.sh /opt/amp-community-dashboard /opt/amp-community-dashboard-phase0 250 3101
```

4. Die Messung starten:

```bash
bash /opt/amp-community-dashboard-phase0/phase0/measure-api.sh 3101
```

Für die weiteren Größen wird jeweils ein neuer, eindeutig benannter Testordner und Port verwendet, beispielsweise:

```bash
bash /opt/amp-community-dashboard/phase0/setup-staging.sh /opt/amp-community-dashboard /opt/amp-community-dashboard-phase0-100 100 3110
bash /opt/amp-community-dashboard-phase0-100/phase0/measure-api.sh 3110
```

## Was gemessen wird

- Antwortzeit und Größe der Health-, Server- und Metrik-API
- Gleichzeitige anfängliche API-Ladevorgänge für 1, 10, 50, 100 und 250 Besucher – getrennt für den einfachen Modus (nur Übersicht) und den erweiterten Modus (Übersicht plus Diagrammdaten)
- Anzahl, Datenmenge und Dauer des SSE-Status-Bursts
- Realistische 24-Stunden-Metrikhistorie mit maximal 300 Messwerten je synthetischem Server

Die synthetischen Einträge haben keine Spielserveradresse. Sie sind nur zur Messung der Datenbank-, Payload- und API-Last vorgesehen. Echte Spielserver werden niemals kontaktiert.

Nach dem Start erzeugt der unveränderte Monitor in einem 30-Sekunden-Zyklus ausschließlich lokale synthetische Statuszustände. Dadurch kann die Messung auch den aktuellen SSE-Datenstrom erfassen, ohne eine Netzwerkverbindung zu einem Spielserver aufzubauen.

## Beenden und entfernen

Der Testdienst kann jederzeit ohne Einfluss auf den Produktivdienst gestoppt werden. Bei der Testgröße `250` lautet der Dienstname beispielsweise:

```bash
systemctl stop amp-community-dashboard-phase0-250
```

Der Testordner enthält ausschließlich künstliche Daten. Entfernen erst nach abgeschlossener Auswertung:

```bash
rm -rf /opt/amp-community-dashboard-phase0
rm -f /etc/systemd/system/amp-community-dashboard-phase0-250.service
systemctl daemon-reload
```
