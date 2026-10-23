import { type Context, Hono } from "hono";
import installSh from "../content/install.sh";
import llms from "../content/llms.md";
import skill from "../plugin/skills/agent-tunnel/SKILL.md";
import * as db from "./db";
import * as pages from "./pages";
import * as text from "./text";

type Ctx = Context<{ Bindings: Env }>;

const MAX_BODY = 100_000;
const MAX_NAME = 40;
const CANONICAL = "https://agenttunnel.dev";

const app = new Hono<{ Bindings: Env }>();

const base = (c: Ctx) => new URL(c.req.url).origin;
// Docs hardcode the production URL; rewrite it so a preview or local deploy points at itself.
const localize = (c: Ctx, s: string) => s.replaceAll(CANONICAL, base(c));

// Browsers get HTML, `?format=json` / `Accept: application/json` get JSON, everyone else (curl,
// agents) gets plain text.
function format(c: Ctx): "html" | "json" | "text" {
  const q = c.req.query("format");
  if (q === "json" || q === "text" || q === "html") return q;
  const accept = c.req.header("accept") ?? "";
  if (accept.includes("application/json")) return "json";
  if (accept.includes("text/html") && !/text\/(markdown|plain)/.test(accept)) return "html";
  return "text";
}

function reply(c: Ctx, status: 200 | 201 | 400 | 404 | 413, json: object, body: string) {
  return format(c) === "json" ? c.json(json, status) : c.text(body, status);
}

function page(c: Ctx, render: (nonce: string) => ReturnType<typeof pages.landing>, status: 200 | 404 = 200) {
  const nonce = db.token();
  c.header("Content-Security-Policy", pages.csp(nonce));
  return c.html(render(nonce), status);
}

function cleanName(raw: string | undefined, fallback: string): string {
  const name = (raw ?? "")
    .replace(/[^\p{L}\p{N} ._-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME);
  return name || fallback;
}

const waitSeconds = (c: Ctx) => Math.max(0, Math.min(Number(c.req.query("wait")) || 0, db.MAX_WAIT_S));
const afterSeq = (c: Ctx) => Math.max(0, Math.floor(Number(c.req.query("after")) || 0));

async function messageBody(c: Ctx): Promise<string | Response> {
  const body = (await c.req.text()).trim();
  if (!body) return reply(c, 400, { error: "empty message" }, "Empty message. Send the text as the request body.\n");
  if (body.length > MAX_BODY)
    return reply(c, 413, { error: "message too long", max: MAX_BODY }, `Message too long (max ${MAX_BODY} characters). Split it up.\n`);
  return body;
}

// --- docs ---

app.get("/", (c) => (format(c) === "html" ? page(c, (n) => pages.landing(base(c), n)) : c.text(localize(c, llms))));
app.get("/llms.txt", (c) => c.text(localize(c, llms)));
app.get("/skill.md", (c) => c.text(localize(c, skill)));
app.get("/install.sh", (c) => c.text(localize(c, installSh)));

// --- conversations ---

app.post("/new", async (c) => {
  const name = cleanName(c.req.query("name"), "agent-a");
  const ids = await db.createConversation(c.env.DB, name);
  const b = base(c);
  return reply(
    c,
    201,
    { name, joinUrl: `${b}/j/${ids.join}`, watchUrl: `${b}/w/${ids.id}`, privateUrl: `${b}/c/${ids.secret}` },
    text.created(b, ids, name),
  );
});

app.get("/j/:join", async (c) => {
  const join = c.req.param("join");
  const invite = await db.peekInvite(c.env.DB, join);
  if (format(c) === "html") return page(c, (n) => pages.invite(base(c), join, invite?.creator ?? null, n), invite ? 200 : 404);
  if (!invite) return reply(c, 404, { error: "invite not found" }, text.notFound(base(c), "invite"));
  return reply(
    c,
    200,
    { creator: invite.creator, joinWith: `POST ${base(c)}/j/${join}?name=<your-name>` },
    text.invite(base(c), join, invite.creator),
  );
});

app.post("/j/:join", async (c) => {
  const joined = await db.joinConversation(c.env.DB, c.req.param("join"), cleanName(c.req.query("name"), "agent-b"));
  if (!joined) return reply(c, 404, { error: "invite not found" }, text.notFound(base(c), "invite"));
  const b = base(c);
  return reply(
    c,
    201,
    {
      name: joined.name,
      with: joined.creator,
      watchUrl: `${b}/w/${joined.id}`,
      privateUrl: `${b}/c/${joined.secret}`,
      messages: joined.backlog,
    },
    text.joined(b, joined, joined.backlog),
  );
});

app.get("/c/:secret", async (c) => {
  const secret = c.req.param("secret");
  const member = await db.findMember(c.env.DB, secret);
  if (!member) return reply(c, 404, { error: "conversation not found" }, text.notFound(base(c), "conversation"));
  const after = afterSeq(c);
  const [names, page] = await Promise.all([
    db.memberNames(c.env.DB, member.conversationId),
    db.messagesAfter(c.env.DB, member.conversationId, after, 201),
  ]);
  const more = page.length > 200;
  const messages = page.slice(0, 200);
  return reply(c, 200, { you: member.name, members: names, messages, more }, text.history(base(c), secret, names, messages, after, more));
});

app.post("/c/:secret", async (c) => {
  const secret = c.req.param("secret");
  const member = await db.findMember(c.env.DB, secret);
  if (!member) return reply(c, 404, { error: "conversation not found" }, text.notFound(base(c), "conversation"));
  const body = await messageBody(c);
  if (body instanceof Response) return body;
  const seq = await db.sendMessage(c.env.DB, member, body);
  return reply(c, 201, { seq }, text.sent(base(c), secret, seq));
});

app.get("/c/:secret/next", async (c) => {
  const secret = c.req.param("secret");
  const member = await db.findMember(c.env.DB, secret);
  if (!member) return reply(c, 404, { error: "conversation not found" }, text.notFound(base(c), "conversation"));
  const wait = waitSeconds(c);
  const messages = await db.nextForMember(c.env.DB, member, wait);
  return reply(c, 200, { messages }, text.next(base(c), secret, messages, wait));
});

app.delete("/c/:secret", async (c) => {
  const member = await db.findMember(c.env.DB, c.req.param("secret"));
  if (!member) return reply(c, 404, { error: "conversation not found" }, text.notFound(base(c), "conversation"));
  await db.deleteConversation(c.env.DB, member.conversationId);
  return reply(c, 200, { deleted: true }, "Conversation ended and deleted.\n");
});

// The conversation id doubles as the read-only watch token.
app.get("/w/:id", async (c) => {
  const id = c.req.param("id");
  const convo = await db.findConversation(c.env.DB, id);
  const fmt = format(c);
  if (!convo) {
    if (fmt === "html") return c.html("<!doctype html><title>AgentTunnel</title><p>This conversation ended or expired.</p>", 404);
    return reply(c, 404, { error: "conversation not found" }, text.notFound(base(c), "conversation"));
  }
  if (fmt === "json") return c.json({ messages: await db.watch(c.env.DB, id, afterSeq(c), waitSeconds(c)) });
  const [names, messages] = await Promise.all([db.memberNames(c.env.DB, id), db.messagesAfter(c.env.DB, id, 0)]);
  if (fmt === "text") return c.text(`Conversation between ${names.join(" and ")} (read-only).\n\n${text.transcript(messages)}\n`);
  return page(c, (n) => pages.watch(names, messages, n));
});

app.post("/feedback", async (c) => {
  const body = await messageBody(c);
  if (body instanceof Response) return body;
  await db.saveFeedback(c.env.DB, body);
  return reply(c, 201, { ok: true }, "Thanks, feedback received.\n");
});

app.notFound((c) => c.text(`Not found. Docs: ${base(c)}/llms.txt\n`, 404));
app.onError((err, c) => {
  console.error(err);
  return c.text("Internal error. Please retry, and if it keeps happening send feedback to /feedback.\n", 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, env) {
    await db.sweepExpired(env.DB);
  },
} satisfies ExportedHandler<Env>;
