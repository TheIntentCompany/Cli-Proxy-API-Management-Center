#!/usr/bin/python3 -I
"""Export only Seat Pacer history. Run as root with the ubuntu group."""
import grp
import os
import shutil
import sys
import tempfile
from pathlib import Path

SOURCE = Path('/var/lib/cliproxy/.cli-proxy-api/plugins/claude-seat-pacer/history.json')
TARGET = Path('/var/lib/intent-seat-pacer/history.json')


def export(source=SOURCE, target=TARGET):
    group = grp.getgrnam('ubuntu').gr_gid
    directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = None
    try:
        os.fchown(directory, 0, group)
        os.fchmod(directory, 0o750)
        fd, temporary = tempfile.mkstemp(prefix='.history-', dir=target.parent)
        with os.fdopen(fd, 'wb') as output, source.open('rb') as input_file:
            shutil.copyfileobj(input_file, output, length=65536)
            os.fchown(output.fileno(), 0, group)
            os.fchmod(output.fileno(), 0o640)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
        temporary = None
        os.fsync(directory)
    finally:
        if temporary is not None:
            os.unlink(temporary)
        os.close(directory)


if __name__ == '__main__':
    try:
        export()
    except OSError:
        sys.stderr.write('seat history export failed category=io\n')
        sys.exit(1)
