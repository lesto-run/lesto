/**
 * The `lesto dev` live-reload + error-overlay CLIENT — the browser JS the dev server
 * injects into every dev HTML response.
 *
 * It is a pure string builder (no socket, no side effects), kept OUT of the bin's
 * `buildLiveReload` wiring for one reason: so the rendering is unit-testable. A test
 * evals this string against a DOM with a fake `WebSocket` and asserts the overlay
 * actually paints — and the bin injects EXACTLY this output, so what ships is what
 * the test exercises. (The bin's `buildLiveReload` binds the real socket and cannot
 * be imported without side effects; this can.)
 *
 * Behaviour, per WebSocket message:
 *   - `{type:"error", source, message, stack?}` → paint a full-screen overlay (source
 *     heading + message + optional stack `<pre>`), never reloading;
 *   - `{type:"style-update"}` → swap the framework stylesheet `<link href="/styles.css">`
 *     in place with a cache-busted href (`/styles.css?t=<n>`), NEVER reloading — so a
 *     Tailwind edit re-paints styles while island/page state survives (ADR 0037 TW4);
 *   - anything else (a `{type:"reload"}`, or a malformed frame) → `location.reload()`;
 *   - a dropped connection → retry every second (so a dev-server restart reloads too).
 *
 * Every dynamic field is written via `textContent` (never `innerHTML`), so an error
 * string that contains markup is inert — no escaping, no injection. `Esc` dismisses a
 * shown overlay. Inlined as one `<script>` so no asset fetch is needed and it runs the
 * moment the document parses; `port` is the only value interpolated into the source.
 */
export function devReloadClientScript(port: number): string {
  return `(()=>{try{
const ID="__lesto_dev_overlay__";
const clear=()=>{const el=document.getElementById(ID);if(el)el.remove();};
const sty=(el,css)=>el.setAttribute("style",css);
const show=(d)=>{clear();
const o=document.createElement("div");o.id=ID;
sty(o,"position:fixed;inset:0;z-index:2147483647;background:rgba(8,8,12,.94);color:#f4f4f5;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;padding:6vh 24px;overflow:auto;");
const card=document.createElement("div");sty(card,"max-width:940px;margin:0 auto;");
const tag=document.createElement("div");sty(tag,"color:#ff7b7b;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:14px;");
tag.textContent="lesto dev — "+(d.source||"error");
const msg=document.createElement("div");sty(msg,"font-size:16px;color:#ffe1e1;white-space:pre-wrap;margin-bottom:18px;");
msg.textContent=d.message||"Unknown dev error";
card.appendChild(tag);card.appendChild(msg);
if(d.stack){const pre=document.createElement("pre");sty(pre,"white-space:pre-wrap;color:#d4d4d8;background:rgba(255,255,255,.06);padding:16px;border-radius:8px;overflow:auto;margin:0;");pre.textContent=d.stack;card.appendChild(pre);}
const hint=document.createElement("div");sty(hint,"margin-top:18px;color:#8a8a93;");
hint.textContent="Fix and save — this clears on the next successful build. Press Esc to dismiss.";
card.appendChild(hint);o.appendChild(card);(document.body||document.documentElement).appendChild(o);};
addEventListener("keydown",(e)=>{if(e.key==="Escape")clear();});
const swap=()=>{const l=document.querySelector('link[rel="stylesheet"][href="/styles.css"],link[rel="stylesheet"][href^="/styles.css?"]');if(l)l.setAttribute("href","/styles.css?t="+Date.now());};
const c=()=>{const s=new WebSocket("ws://"+location.hostname+":${port}");
s.onmessage=(e)=>{let d;try{d=JSON.parse(e.data);}catch{location.reload();return;}if(d&&d.type==="error")show(d);else if(d&&d.type==="style-update")swap();else location.reload();};
s.onclose=()=>setTimeout(c,1000);};c();
}catch{}})();`;
}
