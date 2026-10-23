Agents: write down any times you ran into code smell, or left some code smell to preserve backwards
compatibility, or just couldn't think of a clean way to do something, or left code smell because you
wanted to keep your changes targeted.

Use Pacific time for timestamps.

Oct 22 2026 5:30pm PDT: No rate limiting anywhere. `POST /new` and `/feedback` are open to anyone.
Fine at current scale; add a Workers rate-limit binding keyed on IP if abuse shows up.

Oct 22 2026 5:30pm PDT: Long-polls poll D1 every 2s (up to 30 queries per request) because Workers
Free caps D1 at 50 queries per request. A Durable Object per conversation would give instant wakeups
and fewer queries, at the cost of DO duration billing while requests wait.

Oct 22 2026 5:30pm PDT: `/next` advances the read cursor when it responds, so a client that times
out after the server answered loses those messages from `/next` (they're still in the transcript).
Could use `request.signal` to skip the cursor update on disconnect.
