/**
 * The `lesto dev` in-preview AI overlay CLIENT — the browser JS the dev server injects
 * beside the live-reload client (ADR 0033 Phase 1, increment 1, the keystone).
 *
 * Like {@link import("./dev-overlay").devReloadClientScript} it is a PURE string builder
 * (no socket, no side effects at build time) kept OUT of the bin's wiring for one reason:
 * so the rendering is unit-testable. A test evals this exact string against a DOM with a
 * stub `fetch` and asserts the panel behaves — and the bin injects EXACTLY this output, so
 * what ships is what the test exercises.
 *
 * Behaviour:
 *   - `Cmd-K` / `Ctrl-K` toggles a fixed chat panel (built lazily on first open);
 *   - a submitted prompt POSTs `{ prompt, route }` (the message plus the page's current
 *     `location.pathname`, the one browser-observable context field) — with the per-session dev
 *     token as the `x-lesto-dev-token` header — to the configured relative dev endpoint (the dev
 *     bridge, Inc 6a) and renders the read-only `reply` — INSPECT-ONLY: the client
 *     owns no capability, it only shows what the server says;
 *   - absent a configured endpoint the panel paints a fail-loud "dev MCP server not
 *     available" notice with no input, so a misconfigured dev run reads plainly instead of
 *     silently swallowing a chat turn.
 *
 * Every dynamic field is written via `textContent` (never `innerHTML`), so a reply that
 * contains markup is inert — no escaping, no injection. Inlined as one `<script>`; the only values
 * interpolated into the source are the endpoint and the per-session token, each embedded via
 * `JSON.stringify` so they are always safe string literals.
 */

/** What the injector hands the overlay builder — the dev bridge endpoint, when one exists. */
export interface AiOverlayOptions {
  /**
   * The relative dev endpoint a chat turn POSTs to (the dev MCP bridge, Inc 3). Absent →
   * the overlay paints an inspect-only "dev MCP server not available" state (fail-loud).
   */
  readonly endpoint?: string;

  /**
   * The per-session dev token, presented as the `x-lesto-dev-token` header on the chat POST so the
   * server (`handleAiTurn`) can constant-time compare it. Absent → an empty header, so the server's
   * token check fails and the turn is refused — a misconfigured build fails closed, never open.
   */
  readonly token?: string;
}

/**
 * Build the injected in-preview AI overlay client (ADR 0033 Inc 1).
 *
 * `endpoint` rides into the source as a JSON string literal (`"/path"`) or `null` when the
 * dev bridge is not configured; the script branches on it at runtime — a working chat panel
 * when present, the not-available notice when absent. The returned string is what the bin
 * appends to a dev HTML response.
 */
export function aiOverlayClientScript(options: AiOverlayOptions = {}): string {
  const endpoint = JSON.stringify(options.endpoint ?? null);
  const token = JSON.stringify(options.token ?? "");

  return `(()=>{try{
const ID="__lesto_ai_overlay__";
const EP=${endpoint};
const TOK=${token};
const sty=(el,css)=>el.setAttribute("style",css);
let root;let logEl;let open=false;
const addMsg=(role,text)=>{
const m=document.createElement("div");sty(m,"margin:0 0 12px;");
const who=document.createElement("div");sty(who,"font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#71717a;margin-bottom:3px;");who.textContent=role;
const body=document.createElement("div");sty(body,"white-space:pre-wrap;color:"+(role==="you"?"#a5b4fc":"#e4e4e7")+";");body.textContent=text;
m.appendChild(who);m.appendChild(body);logEl.appendChild(m);logEl.scrollTop=logEl.scrollHeight;};
const send=async(prompt)=>{
addMsg("you",prompt);
try{
const r=await fetch(EP,{method:"POST",headers:{"content-type":"application/json","x-lesto-dev-token":TOK},body:JSON.stringify({prompt,route:document.location.pathname})});
if(!r.ok){addMsg("lesto","request failed ("+r.status+")");return;}
const d=await r.json();addMsg("lesto",d&&typeof d.reply==="string"?d.reply:"(no reply)");
}catch{addMsg("lesto","request failed");}};
const build=()=>{
root=document.createElement("div");root.id=ID;
sty(root,"position:fixed;bottom:20px;right:20px;z-index:2147483646;display:none;flex-direction:column;width:380px;max-height:60vh;background:rgba(9,9,12,.97);color:#f4f4f5;font:13px/1.5 ui-sans-serif,system-ui,sans-serif;border:1px solid #27272a;border-radius:12px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.5);");
const head=document.createElement("div");sty(head,"padding:11px 14px;font-weight:600;border-bottom:1px solid #27272a;color:#e4e4e7;");head.textContent="Lesto dev · Ask Claude (inspect-only)";
logEl=document.createElement("div");sty(logEl,"flex:1;overflow:auto;padding:14px;");
root.appendChild(head);root.appendChild(logEl);
if(EP){
const form=document.createElement("form");sty(form,"display:flex;gap:8px;padding:12px;border-top:1px solid #27272a;");
const input=document.createElement("input");input.type="text";input.placeholder="Ask about this page…";sty(input,"flex:1;background:#18181b;color:#f4f4f5;border:1px solid #3f3f46;border-radius:8px;padding:8px 10px;font:inherit;");
form.appendChild(input);
form.addEventListener("submit",(e)=>{e.preventDefault();const v=input.value.trim();if(!v)return;input.value="";send(v);});
root.appendChild(form);
}else{
const na=document.createElement("div");sty(na,"padding:14px;color:#fca5a5;border-top:1px solid #27272a;");na.textContent="dev MCP server not available — inspect-only overlay, no chat endpoint configured.";
root.appendChild(na);}
(document.body||document.documentElement).appendChild(root);};
const toggle=()=>{if(!root)build();open=!open;root.style.display=open?"flex":"none";};
addEventListener("keydown",(e)=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){e.preventDefault();toggle();}});
}catch{}})();`;
}
