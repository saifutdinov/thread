#!/usr/bin/env python3
"""Check a decrypted snapshot against its manifest and encrypted media files."""
import argparse
import json
from pathlib import Path
import re
import sqlite3
import sys


def verify(database: Path, manifest: Path, media: Path) -> int:
    description = json.loads(manifest.read_text(encoding="utf-8"))
    if not isinstance(description, dict) or "files" not in description:
        raise ValueError("invalid manifest")
    files = description.get("files")
    # Empty snapshots written by Go encode a nil slice as null.
    if files is None:
        files = []
    if description.get("version") != 1 or not isinstance(files, list):
        raise ValueError("unsupported manifest")
    if any(not isinstance(name, str) or not re.fullmatch(r"[0-9a-fA-F]{32}", name) for name in files):
        raise ValueError("invalid media id in manifest")
    if len(set(files)) != len(files):
        raise ValueError("duplicate media ids in manifest")
    db = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError("SQLite integrity check failed")
        expected = dict(db.execute("SELECT id, size FROM media WHERE message_id IS NOT NULL"))
    finally:
        db.close()
    if set(expected) != set(files):
        raise ValueError("manifest does not match the snapshot's attached media")
    for name, size in expected.items():
        path = media / name
        if not path.is_file() or path.stat().st_size != size:
            raise ValueError(f"missing or truncated media: {name}")
    return len(files)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--media", type=Path, required=True)
    args = parser.parse_args()
    try:
        count = verify(args.database, args.manifest, args.media)
    except (OSError, ValueError, sqlite3.Error, AttributeError) as error:
        print(f"Backup verification failed: {error}", file=sys.stderr)
        return 1
    print(f"Backup complete: SQLite valid, {count} attached media files present with expected sizes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
