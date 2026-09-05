# Phase 0 – gemessene Ausgangsbasis

Messung vom 5. September 2026. Alle Lastszenarien liefen ausschließlich gegen isolierte, lokale Testkopien mit synthetischen Servern. Es wurden keine Spielserver kontaktiert und keine Produktivdaten verändert.

## Produktivsystem mit sechs Servern

| Messwert | Ergebnis |
| --- | ---: |
| Datenbankgröße | 228 KB |
| Prozess-CPU | 0,2 % |
| Prozess-RSS | 99.180 KB |
| Health-API | Ø 1,51 ms / 63 Bytes |
| Server-API | Ø 5,13 ms / 5.248 Bytes |
| Metriken-API | Ø 3,32 ms / 27.753 Bytes |
| SSE in 40 Sekunden | 31.665 Bytes |

## Isolierte Lastszenarien

| Server | Server-API | Metriken-API | 100 parallele anfängliche Ladevorgänge |
| ---: | --- | --- | --- |
| 10 | Ø 6,59 ms / 9.295 Bytes | Ø 12,67 ms / 244.623 Bytes | 1.942 ms gesamt, Ø 575,90 ms, maximal 873,84 ms |
| 50 | Ø 22,89 ms / 45.348 Bytes | Ø 55,04 ms / 1.223.063 Bytes | 6.937 ms gesamt, Ø 2.294,53 ms, maximal 4.150,14 ms |
| 100 | Ø 38,79 ms / 90.397 Bytes | Ø 108,45 ms / 2.446.113 Bytes | 13.801 ms gesamt, Ø 4.381,30 ms, maximal 9.318,63 ms |
| 250 | Ø 127,13 ms / 225.842 Bytes | Ø 399,66 ms / 6.115.263 Bytes | 64.082 ms gesamt, Ø 16.404,14 ms, maximal 53.056,29 ms |

## SSE-Messungen

| Server | Ereignisse | Datenmenge | Zeit bis zum ersten Ereignis | Dauer des Ereignis-Bursts |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 10 | 91.769 Bytes | 25.513 ms | 1 ms |
| 50 | 50 | 2.241.177 Bytes | 19.121 ms | 112 ms |
| 100 | 100 | 8.938.687 Bytes | 10.215 ms | 147 ms |
| 250 | Noch nicht verwertbar erfasst | – | – | – |

## Befund

Die Messung belegt die erwartete quadratische Last des bisherigen Aktualisierungswegs: Jede Statusbeobachtung erzeugt ein vollständiges Dashboard-Ereignis. Der Browser lädt anschließend die gesamten Metriken und erstellt alle Karten neu.

Die verbindlichen P0-Ziele sind deshalb:

1. Kleine SSE-Delta-Ereignisse je betroffenem Server.
2. Nur die betroffene Serverkarte im Browser aktualisieren.
3. Metriken vom Status-SSE-Zyklus trennen.
4. Dashboard- und Uptime-Berechnungen cachen bzw. gezielt aktualisieren.
5. Backpressure und Ereignis-Zusammenfassung im SSE-Hub einführen.

## Noch offene Vergleichswerte

- Vollständige 250er-SSE-Messung nach einem nicht blockierten Statuszyklus
- CPU/RAM unter der 250er-Last
- Direkte Event-Loop-Latenz
- SQLite-Abfrageanzahl
- Browser-DOM-Renderzeit

Diese fehlenden Werte verhindern nicht die P0-Umsetzung. Sie werden nach der Optimierung als Vorher-Nachher-Vergleich ergänzt.
