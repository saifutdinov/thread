package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// Times are unix milliseconds everywhere: the browser works in ms.
func now() int64 { return time.Now().UnixMilli() }

const schema = `
CREATE TABLE IF NOT EXISTS users (
	id          INTEGER PRIMARY KEY,
	name        TEXT    NOT NULL,
	pass_lookup BLOB    NOT NULL UNIQUE,
	invited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
	hide_online INTEGER NOT NULL DEFAULT 0,
	last_seen   INTEGER NOT NULL DEFAULT 0,
	created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
	id         INTEGER PRIMARY KEY,
	user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	enc_pub    BLOB    NOT NULL,
	sig_pub    BLOB    NOT NULL,
	label      TEXT    NOT NULL,
	status     TEXT    NOT NULL CHECK (status IN ('pending','active','revoked')),
	recovery   INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	last_seen  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id);
CREATE TABLE IF NOT EXISTS sessions (
	token_hash BLOB    PRIMARY KEY,
	device_id  INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
	id           INTEGER PRIMARY KEY,
	kind         TEXT    NOT NULL CHECK (kind IN ('direct','group')),
	title        BLOB,
	title_epoch  INTEGER NOT NULL DEFAULT 0,
	epoch        INTEGER NOT NULL DEFAULT 1,
	rotate       INTEGER NOT NULL DEFAULT 0,
	cleared_upto INTEGER NOT NULL DEFAULT 0,
	created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
	created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
	chat_id   INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
	user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	last_read INTEGER NOT NULL DEFAULT 0,
	joined_at INTEGER NOT NULL,
	PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
CREATE TABLE IF NOT EXISTS chat_keys (
	chat_id   INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
	epoch     INTEGER NOT NULL,
	device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	wrapped   BLOB    NOT NULL,
	PRIMARY KEY (chat_id, epoch, device_id)
);
CREATE INDEX IF NOT EXISTS chat_keys_device ON chat_keys(device_id);
CREATE TABLE IF NOT EXISTS invites (
	id         BLOB    PRIMARY KEY,
	chat_id    INTEGER REFERENCES chats(id) ON DELETE CASCADE,
	created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
	bundle     BLOB,
	max_uses   INTEGER NOT NULL,
	uses       INTEGER NOT NULL DEFAULT 0,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
	id         INTEGER PRIMARY KEY,
	chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
	user_id    INTEGER NOT NULL,
	device_id  INTEGER NOT NULL,
	client_id  TEXT    NOT NULL,
	epoch      INTEGER NOT NULL,
	body       BLOB,
	sig        BLOB,
	reply_to   INTEGER NOT NULL DEFAULT 0,
	has_media  INTEGER NOT NULL DEFAULT 0,
	seq        INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	edited_at  INTEGER NOT NULL DEFAULT 0,
	deleted    INTEGER NOT NULL DEFAULT 0,
	UNIQUE (device_id, client_id)
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS messages_seq ON messages(seq);
CREATE TABLE IF NOT EXISTS reactions (
	message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
	user_id    INTEGER NOT NULL,
	epoch      INTEGER NOT NULL,
	body       BLOB    NOT NULL,
	PRIMARY KEY (message_id, user_id)
);
CREATE TABLE IF NOT EXISTS media (
	id         TEXT    PRIMARY KEY,
	chat_id    INTEGER NOT NULL,
	uploader   INTEGER NOT NULL,
	message_id INTEGER,
	size       INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS media_message ON media(message_id);
CREATE INDEX IF NOT EXISTS media_chat ON media(chat_id);
CREATE TABLE IF NOT EXISTS push_subs (
	device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
	endpoint  TEXT NOT NULL,
	p256dh    TEXT NOT NULL,
	auth      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
	k TEXT PRIMARY KEY,
	v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS counter (
	id  INTEGER PRIMARY KEY CHECK (id = 1),
	seq INTEGER NOT NULL
);
INSERT OR IGNORE INTO counter (id, seq) VALUES (1, 0);
`

// migrations upgrade the schema above, which is frozen at version 0 (the
// first production release). Each runs once, in order, tracked by
// PRAGMA user_version. Append only: never edit an applied migration.
var migrations = []string{
	`ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE chats ADD COLUMN epoch_at INTEGER NOT NULL DEFAULT 0`,
	`UPDATE chats SET epoch_at = created_at`,
	`ALTER TABLE media ADD COLUMN backed_up INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE members ADD COLUMN avatar BLOB`,
	`ALTER TABLE members ADD COLUMN avatar_epoch INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE members ADD COLUMN avatar_v INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE users ADD COLUMN avatar_v INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE chats ADD COLUMN photo BLOB`,
	`ALTER TABLE chats ADD COLUMN photo_epoch INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE chats ADD COLUMN photo_v INTEGER NOT NULL DEFAULT 0`,
	`CREATE TABLE recoveries (
	id         BLOB    PRIMARY KEY,
	user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	bundle     BLOB    NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
)`,
}

func migrate(db *sql.DB) error {
	var v int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return err
	}
	for i := v; i < len(migrations); i++ {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migrations[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// openDB opens SQLite in WAL mode. _txlock=immediate makes every
// transaction take the write lock up front, so concurrent writers wait on
// busy_timeout instead of failing with SQLITE_BUSY on lock upgrade.
func openDB(path string) (*sql.DB, error) {
	dsn := "file:" + path + "?_txlock=immediate" +
		"&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)" +
		"&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return db, nil
}

// nextSeq hands out the global change counter used by /api/sync.
func nextSeq(ctx context.Context, tx *sql.Tx) (int64, error) {
	var v int64
	err := tx.QueryRowContext(ctx, `UPDATE counter SET seq = seq + 1 WHERE id = 1 RETURNING seq`).Scan(&v)
	return v, err
}

func inTx(ctx context.Context, db *sql.DB, fn func(*sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// placeholders returns "?,?,?" and the ids as args for an IN clause.
func placeholders(ids []int64) (string, []any) {
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	return strings.TrimSuffix(strings.Repeat("?,", len(ids)), ","), args
}

func metaGet(ctx context.Context, db *sql.DB, k string) (string, error) {
	var v string
	err := db.QueryRowContext(ctx, `SELECT v FROM meta WHERE k = ?`, k).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

func metaSet(ctx context.Context, db *sql.DB, k, v string) error {
	_, err := db.ExecContext(ctx, `INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v)
	return err
}

func isMember(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, chatID, userID int64) bool {
	var one int
	err := q.QueryRowContext(ctx, `SELECT 1 FROM members WHERE chat_id = ? AND user_id = ?`, chatID, userID).Scan(&one)
	return err == nil
}

// chatUserIDs lists the members of a chat (event fan-out targets).
func chatUserIDs(ctx context.Context, db *sql.DB, chatID int64) ([]int64, error) {
	return queryIDs(ctx, db, `SELECT user_id FROM members WHERE chat_id = ?`, chatID)
}

// contactIDs lists users sharing at least one chat with userID, plus userID.
func contactIDs(ctx context.Context, db *sql.DB, userID int64) ([]int64, error) {
	return queryIDs(ctx, db, `SELECT DISTINCT m2.user_id FROM members m1
		JOIN members m2 ON m2.chat_id = m1.chat_id WHERE m1.user_id = ?`, userID)
}

func queryIDs(ctx context.Context, db *sql.DB, q string, args ...any) ([]int64, error) {
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
