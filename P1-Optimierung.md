# Phase 1 – v2.6.0

Phase 1 reduziert die verbleibende Last des erweiterten Modus ohne neue Bedienoberfläche oder Konfiguration.

- Sichtbare Diagrammkarten werden innerhalb kurzer Zeit gemeinsam angefragt, maximal zwölf Server pro Abruf.
- Die Darstellung erhält maximal 120 sinnvoll ausgewählte Messpunkte je Server. Lokale Minima und Maxima bleiben dabei erhalten, damit Latenzspitzen sichtbar bleiben.
- Die vollständige öffentliche Metrik-API bleibt kompatibel. Neue Abfragen können `serverIds` und `points` verwenden, zum Beispiel `GET /api/v1/public/metrics?serverIds=<id1>,<id2>&points=120`.
- Metrikdaten werden serverseitig für 30 Sekunden zwischengespeichert und bei einer neuen Messung sofort ungültig gemacht.
- Ein neues SSE-Messereignis enthält nur den neuen Messpunkt. Nur ein Browser mit offenem Diagramm fordert danach eine kompakte Aktualisierung an.
