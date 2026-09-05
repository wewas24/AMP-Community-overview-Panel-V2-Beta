# Phase 0 – Zwischenmessung v2.5.0

Messung mit 250 isolierten, synthetischen Servern am 5. September 2026. Der Testdienst war ausschließlich über die lokale Loopback-Adresse erreichbar.

## Ergebnis

| Szenario | Gesamtzeit | Datenmenge |
| --- | ---: | ---: |
| 100 Besucher, einfach | 462 ms | 22,6 MB |
| 250 Besucher, einfach | 1.622 ms | 55,2 MB |
| 100 Besucher, erweitert (vor Sichtbarkeitsoptimierung) | 30.558 ms | 634,1 MB |
| 250 Besucher, erweitert (vor Sichtbarkeitsoptimierung) | 70.025 ms | 1,58 GB |
| SSE über 40 Sekunden | 64.933 Bytes | 116 Ereignisse |

## Einordnung

Die Delta-SSE-Umstellung funktioniert: Statt vollständiger Dashboard-Payloads werden kleine Statusänderungen übertragen. Auch der einfache Modus zeigt bei 250 parallelen Besuchern eine gute Startzeit.

Der Engpass blieb im erweiterten Modus: Jeder Besucher rief noch die vollständige 24-Stunden-Historie aller 250 Server ab. Ein einzelner Abruf betrug 6,1 MB. Deshalb lädt v2.5.1 Diagrammdaten nur noch für Karten im oder nahe dem sichtbaren Bereich sowie beim Öffnen der Detailansicht. Neue Messpunkte werden als einzelner Wert übertragen.

Die nächste Messung muss mit v2.5.1 wiederholt werden; erst dann ist der P0-Vorher-Nachher-Vergleich abgeschlossen.
