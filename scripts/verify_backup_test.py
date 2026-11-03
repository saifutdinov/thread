import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from verify_backup import verify


class BackupVerificationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.database = self.root / "snapshot.db"
        self.manifest = self.root / "manifest.json"
        self.media = self.root / "media"
        self.media.mkdir()
        self.id = "a" * 32
        db = sqlite3.connect(self.database)
        db.execute("CREATE TABLE media (id TEXT, size INTEGER, message_id INTEGER)")
        db.execute("INSERT INTO media VALUES (?, 6, 1)", (self.id,))
        db.commit()
        db.close()
        self.manifest.write_text(json.dumps({"version": 1, "files": [self.id]}), encoding="utf-8")
        (self.media / self.id).write_bytes(b"sealed")

    def test_complete_snapshot(self):
        self.assertEqual(verify(self.database, self.manifest, self.media), 1)

    def test_missing_and_truncated_media(self):
        (self.media / self.id).unlink()
        with self.assertRaisesRegex(ValueError, "missing or truncated"):
            verify(self.database, self.manifest, self.media)
        (self.media / self.id).write_bytes(b"short")
        with self.assertRaisesRegex(ValueError, "missing or truncated"):
            verify(self.database, self.manifest, self.media)

    def test_manifest_must_match_snapshot(self):
        for files in [[], [self.id, self.id], ["../outside"]]:
            self.manifest.write_text(json.dumps({"version": 1, "files": files}), encoding="utf-8")
            with self.assertRaises(ValueError):
                verify(self.database, self.manifest, self.media)


if __name__ == "__main__":
    unittest.main()
