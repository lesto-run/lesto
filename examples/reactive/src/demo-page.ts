/**
 * The human-facing demo page: a vanilla `EventSource` + `fetch` mirror of what
 * `@lesto/ui`'s `useQuery` + `useLive` do in a real Lesto app.
 *
 * It is hand-rolled JS on purpose — the example serves it as a plain string so it runs
 * with no island build step, so you can open two browser tabs and WATCH a post in one
 * appear live in the other. In a real app you would not write any of the stream code:
 * you would call `useQuery("messages", read, { topics: [`room:${room}`] })` and
 * `useLive([`room:${room}`])`, and the framework would do exactly what this page does by
 * hand — subscribe to `/__lesto/live`, and refetch the query when its topic invalidates.
 */
export function demoPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lesto — live queries demo</title>
  <style>
    body { font: 15px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
    label { margin-right: 1rem; }
    #log { border: 1px solid #ccc; border-radius: 6px; padding: .5rem 1rem; min-height: 6rem; }
    .msg { padding: .15rem 0; }
    .who { color: #666; }
    form { margin: 1rem 0; display: flex; gap: .5rem; }
    input[type=text] { flex: 1; padding: .4rem; }
    .hint { color: #666; font-size: 13px; }
  </style>
</head>
<body>
  <h1>Live queries</h1>
  <p class="hint">Open this page in two tabs. Post in one; watch it appear in the other with no reload —
    the mutation invalidates a topic the other tab subscribes to over SSE. Try <code>alice</code> vs
    <code>bob</code> on the <code>secret</code> room: bob is not a member, so bob's tab never sees it
    (not even the timing).</p>

  <p>
    <label>User: <select id="user"><option>alice</option><option>bob</option><option value="">anon</option></select></label>
    <label>Room: <select id="room"><option>general</option><option>secret</option></select></label>
  </p>

  <div id="log"></div>

  <form id="post">
    <input id="text" type="text" placeholder="Say something…" autocomplete="off" />
    <button type="submit">Post</button>
  </form>

  <script type="module">
    const $ = (id) => document.getElementById(id);
    let source;

    // Render a message list with safe DOM methods (textContent) — never innerHTML with
    // server data, or a posted \`<script>\` would run in every other tab (stored XSS).
    function render(node) {
      const log = $("log");
      log.replaceChildren();
      log.append(node);
    }
    function italic(text) { const em = document.createElement("em"); em.textContent = text; return em; }

    // The authorized read a live query calls (and refetches on invalidation).
    async function read() {
      const user = $("user").value, room = $("room").value;
      const res = await fetch(\`/messages?room=\${room}&user=\${user}\`);
      if (!res.ok) { render(italic(\`You cannot see #\${room}.\`)); return; }
      const { messages } = await res.json();
      if (messages.length === 0) { render(italic("No messages yet.")); return; }
      const frag = document.createDocumentFragment();
      for (const m of messages) {
        const div = document.createElement("div"); div.className = "msg";
        const who = document.createElement("span"); who.className = "who"; who.textContent = m.user + ":";
        div.append(who, " " + m.text); // a text node — the message is never parsed as HTML
        frag.append(div);
      }
      render(frag);
    }

    // Subscribe to the room's topic; refetch when the server invalidates it (live useQuery).
    function connect() {
      if (source) source.close();
      const user = $("user").value, room = $("room").value;
      source = new EventSource(\`/__lesto/live?topics=room:\${room}&user=\${user}\`);
      source.addEventListener("invalidate", read);
      source.addEventListener("resync", read);
      read();
    }

    $("user").addEventListener("change", connect);
    $("room").addEventListener("change", connect);

    $("post").addEventListener("submit", async (e) => {
      e.preventDefault();
      const user = $("user").value, room = $("room").value, text = $("text").value.trim();
      if (!text) return;
      $("text").value = "";
      await fetch(\`/messages?user=\${user}\`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room, text }),
      });
      // No manual refresh: our own SSE invalidation refetches us, exactly like every other tab.
    });

    connect();
  </script>
</body>
</html>`;
}
