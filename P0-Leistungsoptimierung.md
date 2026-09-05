# P0-Leistungsoptimierung – v2.5.0

Dieses Update ist mit bestehenden V2-Daten kompatibel. Der Ordner `data/` wird beim Update nicht ersetzt.

## Umgesetzt

- Statusprüfungen senden per SSE nur noch ein kompaktes Delta für den betroffenen Server statt eines vollständigen Dashboards.
- Der Browser ersetzt bei einer Statusänderung nur die betroffene Karte. Nur bei einer aktiven Status-/Latenz-/Spielersortierung wird die sichtbare Liste neu sortiert.
- Der einfache Modus lädt keine 24-Stunden-Metriken. Im erweiterten Modus werden sie beim Umschalten, beim Öffnen einer Detailansicht oder bei einem neuen Messwert gezielt geladen.
- Uptime-Werte und die öffentliche Dashboard-Übersicht werden kurzzeitig gecacht und bei einer echten Strukturänderung gezielt invalidiert.
- Der SSE-Hub begrenzt wartende Ereignisse. Bei einem langsamen Browser werden Werte pro Server zusammengefasst; ist der Puffer voll, fordert ein einzelnes `resync` eine saubere Nachsynchronisierung an.
- Die Versionsnummer kommt aus `package.json`. HTML-Assets, Service Worker, Health-API, Logausgabe und Erkennungskennung verwenden dieselbe Version.
- Die Phase-0-Messung unterscheidet nun einfachen und erweiterten Erstaufruf und enthält 250-Besucher-Szenarien.

## Erwartete Wirkung

Bei Statuswechseln wächst die Datenmenge nicht mehr mit der Anzahl aller Server und der Browser lädt nicht mehr für jede einzelne Änderung alle Diagrammdaten. Besonders bei vielen Servern und parallelen Besuchern reduziert das die Datenbank-, Netzwerk- und Browserlast deutlich.

## Nach dem Update messen

Die konkrete Verbesserung hängt von Serverzahl, Browsern und Statusintervall ab. Für einen belastbaren Vorher-Nachher-Vergleich die isolierte Phase-0-Messung aus `phase0/README.md` mit 250 synthetischen Servern ausführen. Sie berührt weder den Produktivdienst noch Produktivdaten.
