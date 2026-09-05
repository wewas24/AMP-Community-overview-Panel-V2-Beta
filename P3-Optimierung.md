# Phase 3 – v2.8.0

Phase 3 reduziert die Netzwerklast öffentlicher Datenzugriffe, ohne Anmeldung oder Verwaltung zu verändern.

- `GET /api/v1/public/servers`, `GET /api/v1/public/statuses` und `GET /api/v1/public/metrics` liefern große Antworten als gzip aus, wenn der anfragende Client gzip unterstützt.
- Die Antwort enthält `Vary: Accept-Encoding`, sodass Reverse-Proxys keine komprimierte und unkomprimierte Variante vermischen.
- Die Anwendung wiederverwendet öffentliche JSON- und gzip-Payloads je Datenstand. Der Cache ist auf 64 Varianten begrenzt und wird sofort bei Status-, Messwert- oder Strukturänderungen verworfen.
- Anmelde-, Sitzungs- und Verwaltungsantworten sind absichtlich nicht Teil dieser Komprimierung.
- Die Phase-0-Messung fordert ab dieser Version komprimierte Browser-Übertragung an.
