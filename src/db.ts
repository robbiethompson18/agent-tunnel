// All D1 access. Timestamps are unix ms; secrets and join tokens are stored as SHA-256 hex.

export const TTL_MS = 7 * 24 * 3600_000; // conversations die after 7 days without a message
const POLL_MS = 2000;
export const MAX_WAIT_S = 60; // 30 polls at 2s; D1 on the free plan allows 50 queries per request
const PAGE = 200;

export type Message = { seq: number; senderIdx: number | null; sender: string | null; body: string; createdAt: number };
export type Member = { conversationId: string; idx: number; name: string; readSeq: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 16 random bytes → 22-char base64url, ~128 bits.
export function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const liveSince = () => Date.now() - TTL_MS;

export async function createConversation(db: D1Database, name: string) {
  const [id, join, secret] = [token(), token(), token()];
  const now = Date.now();
  await db.batch([
    db
      .prepare("INSERT INTO conversations (id, join_hash, created_at, last_activity_at) VALUES (?, ?, ?, ?)")
      .bind(id, await sha256(join), now, now),
    db
      .prepare("INSERT INTO members (conversation_id, idx, name, secret_hash, joined_at) VALUES (?, 1, ?, ?, ?)")
      .bind(id, name, await sha256(secret), now),
  ]);
  return { id, join, secret };
}

// Who created the conversation behind a still-unused join token, or null if used/expired/bogus.
export async function peekInvite(db: D1Database, join: string) {
  return db
    .prepare(
      `SELECT c.id, m.name AS creator FROM conversations c JOIN members m ON m.conversation_id = c.id AND m.idx = 1
       WHERE c.join_hash = ? AND c.last_activity_at > ?`,
    )
    .bind(await sha256(join), liveSince())
    .first<{ id: string; creator: string }>();
}

export async function joinConversation(db: D1Database, join: string, requestedName: string) {
  // Clearing join_hash in the same statement that finds it makes the token single-use, even under races.
  const now = Date.now();
  const claimed = await db
    .prepare("UPDATE conversations SET join_hash = NULL, last_activity_at = ? WHERE join_hash = ? AND last_activity_at > ? RETURNING id")
    .bind(now, await sha256(join), liveSince())
    .first<{ id: string }>();
  if (!claimed) return null;
  const { id } = claimed;
  const creator = await db.prepare("SELECT name FROM members WHERE conversation_id = ? AND idx = 1").bind(id).first<string>("name");
  const name = requestedName === creator ? `${requestedName}-2` : requestedName;
  const secret = token();
  const [joinedMessage] = await db.batch<{ seq: number }>([
    insertMessage(db, id, null, `${name} joined`, now),
    // The joiner is handed the backlog right away, so their /next cursor starts past it.
    db
      .prepare(
        `INSERT INTO members (conversation_id, idx, name, secret_hash, read_seq, joined_at)
         VALUES (?1, 2, ?2, ?3, (SELECT MAX(seq) FROM messages WHERE conversation_id = ?1), ?4)`,
      )
      .bind(id, name, await sha256(secret), now),
  ]);
  const readSeq = joinedMessage?.results[0]?.seq ?? 0;
  const backlog = (await messagesAfter(db, id, 0)).filter((m) => m.seq <= readSeq);
  return { id, secret, name, creator: creator ?? "?", backlog };
}

export async function findMember(db: D1Database, secret: string) {
  return db
    .prepare(
      `SELECT m.conversation_id AS conversationId, m.idx, m.name, m.read_seq AS readSeq
       FROM members m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.secret_hash = ? AND c.last_activity_at > ?`,
    )
    .bind(await sha256(secret), liveSince())
    .first<Member>();
}

export async function findConversation(db: D1Database, id: string) {
  return db
    .prepare(
      "SELECT id, created_at AS createdAt, last_activity_at AS lastActivityAt FROM conversations WHERE id = ? AND last_activity_at > ?",
    )
    .bind(id, liveSince())
    .first<{ id: string; createdAt: number; lastActivityAt: number }>();
}

export async function memberNames(db: D1Database, conversationId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT name FROM members WHERE conversation_id = ? ORDER BY idx")
    .bind(conversationId)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

function insertMessage(db: D1Database, conversationId: string, senderIdx: number | null, body: string, now: number) {
  // seq is assigned inside the INSERT so concurrent sends can't collide (D1 serializes writes).
  return db
    .prepare(
      `INSERT INTO messages (conversation_id, seq, sender_idx, body, created_at)
       SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2, ?3, ?4 FROM messages WHERE conversation_id = ?1
       RETURNING seq`,
    )
    .bind(conversationId, senderIdx, body, now);
}

export async function sendMessage(db: D1Database, member: Member, body: string): Promise<number> {
  const now = Date.now();
  const [inserted] = await db.batch<{ seq: number }>([
    insertMessage(db, member.conversationId, member.idx, body, now),
    db.prepare("UPDATE conversations SET last_activity_at = ? WHERE id = ?").bind(now, member.conversationId),
  ]);
  const seq = inserted?.results[0]?.seq;
  if (seq === undefined) throw new Error("insert returned no seq");
  return seq;
}

export async function messagesAfter(db: D1Database, conversationId: string, after: number, limit = PAGE): Promise<Message[]> {
  const { results } = await db
    .prepare(
      `SELECT msg.seq, msg.sender_idx AS senderIdx, m.name AS sender, msg.body, msg.created_at AS createdAt
       FROM messages msg LEFT JOIN members m ON m.conversation_id = msg.conversation_id AND m.idx = msg.sender_idx
       WHERE msg.conversation_id = ? AND msg.seq > ? ORDER BY msg.seq LIMIT ?`,
    )
    .bind(conversationId, after, limit)
    .all<Message>();
  return results;
}

// Long-poll: return the first non-empty batch after `after` that passes `keep`, or [] at the deadline.
// Returns the last seq examined too, so callers can advance a cursor past filtered-out rows.
async function waitForMessages(db: D1Database, conversationId: string, after: number, waitS: number, keep: (m: Message) => boolean) {
  const deadline = Date.now() + Math.min(waitS, MAX_WAIT_S) * 1000;
  let cursor = after;
  for (;;) {
    const rows = await messagesAfter(db, conversationId, cursor);
    cursor = rows.at(-1)?.seq ?? cursor;
    const kept = rows.filter(keep);
    if (kept.length > 0 || Date.now() + POLL_MS > deadline) return { messages: kept, cursor };
    await sleep(POLL_MS);
  }
}

// Messages this member hasn't been handed yet (excluding their own), advancing their cursor.
export async function nextForMember(db: D1Database, member: Member, waitS: number): Promise<Message[]> {
  const { messages, cursor } = await waitForMessages(db, member.conversationId, member.readSeq, waitS, (m) => m.senderIdx !== member.idx);
  if (cursor !== member.readSeq) {
    await db
      .prepare("UPDATE members SET read_seq = ? WHERE conversation_id = ? AND idx = ?")
      .bind(cursor, member.conversationId, member.idx)
      .run();
  }
  return messages;
}

export async function watch(db: D1Database, conversationId: string, after: number, waitS: number): Promise<Message[]> {
  return (await waitForMessages(db, conversationId, after, waitS, () => true)).messages;
}

export async function deleteConversation(db: D1Database, conversationId: string) {
  await db.prepare("DELETE FROM conversations WHERE id = ?").bind(conversationId).run();
}

export async function sweepExpired(db: D1Database) {
  await db.prepare("DELETE FROM conversations WHERE last_activity_at <= ?").bind(liveSince()).run();
}

export async function saveFeedback(db: D1Database, body: string) {
  await db.prepare("INSERT INTO feedback (body, created_at) VALUES (?, ?)").bind(body, Date.now()).run();
}
