# Seat Pacer history export

The root oneshot copies only the Seat Pacer history file into `/var/lib/intent-seat-pacer/history.json` every two minutes. It writes a temporary file, sets `0640 root:ubuntu`, fsyncs, renames and fsyncs the `0750 root:ubuntu` directory. A failed copy leaves the previous export intact. It never opens an auth file or contacts a service.

Install commands for both services are in [the collector README](../usage-collector/README.md#install-on-ubuntu). The exporter needs root access to the source directory. The collector runs as ubuntu and reads only the exported copy. The source writer is expected to replace history atomically.
