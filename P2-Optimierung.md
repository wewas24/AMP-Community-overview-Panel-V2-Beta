# Phase 2 – v2.7.0

Phase 2 optimiert große Übersichten, ohne neue Schalter oder kompliziertere Bedienung.

- Serverkarten außerhalb des sichtbaren Bereichs werden vom Browser erst beim Scrollen vollständig berechnet. Ältere Browser verwenden weiterhin die bestehende Darstellung.
- Filter- und Suchtreffer verwenden einen vorbereiteten Suchindex. Während der Eingabe wird das Kartenraster nur einmal nach einer kurzen Pause aufgebaut.
- Mehrere Kartenupdates aus einer Diagramm-Sammelabfrage ersetzen die betroffenen Elemente gemeinsam statt jeweils einzeln den Beobachter neu aufzubauen.
- Die öffentliche Metrik-API unterstützt zusätzlich `format=compact`. Sie gibt dann `format: "compact-v1"`, die Spalten `checkedAtMs`, `latencyMs`, `players`, `maxPlayers` und Zahlenreihen aus. Bestehende API-Aufrufe bleiben unverändert.
