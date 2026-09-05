# Phase 4 – v2.9.0

Phase 4 verbessert die interne Verarbeitung bei vielen gleichzeitigen Besuchern. Sie ändert weder die sichtbare Oberfläche noch Berechtigungen, Monitoring oder gespeicherte Serverdaten.

- SQLite verwendet jetzt Write-Ahead Logging (WAL), einen kurzen Busy-Timeout und speicherschonende temporäre Tabellen. Lesen der öffentlichen Übersicht blockiert dadurch seltener parallele Status- oder Verwaltungsänderungen.
- Die unveränderte Serverkonfiguration wird pro Serverprozess zwischengespeichert. Der Cache wird bei Anlegen, Bearbeiten, Löschen, Sortieren, Import oder Migration sofort verworfen.
- Beim kontrollierten Beenden schreibt SQLite einen nicht blockierenden Checkpoint. Dadurch bleiben Daten konsistent und der nächste Start ist schlank.
- Die Datenbank selbst wird beim Update nicht verändert oder ersetzt. Bei aktivem Dienst können neben der Datenbankdatei vorübergehend Dateien mit den Endungen `-wal` und `-shm` erscheinen. Das ist bei SQLite-WAL normal; den Ordner `data/` weiterhin vollständig erhalten.
