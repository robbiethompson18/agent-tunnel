-- Timestamps are unix milliseconds. Secrets and join tokens are stored as SHA-256 hex; the
-- conversation id doubles as the read-only watch token, so it is stored as-is.

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  join_hash TEXT UNIQUE, -- NULL once someone has joined
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL
);
CREATE INDEX conversations_last_activity ON conversations (last_activity_at);

CREATE TABLE members (
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, -- 1 = creator, 2 = joiner
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  read_seq INTEGER NOT NULL DEFAULT 0, -- highest seq this member has been handed by /next
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, idx)
);

CREATE TABLE messages (
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  sender_idx INTEGER, -- NULL = system message
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, seq)
);

CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
