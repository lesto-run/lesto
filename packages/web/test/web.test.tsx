import { describe, expect, it } from "vitest";

import { Router } from "@keel/router";
import { Registry } from "@keel/ui";

import { Application, Controller, WebError } from "../src/index";

import type { AnyKeelResponse, ControllerClass } from "../src/index";

// A tiny registry with a single component, used to prove renderTree SSRs to HTML.
const greetingRegistry = new Registry().define({
  name: "Greeting",
  props: { who: { type: "string", required: true } },
  children: false,
  render: (props) => <h1>Hello {String(props.who)}</h1>,
});

// A controller exercising every response helper plus sync/async dispatch.
class ProbeController extends Controller {
  showJson(): ReturnType<Controller["json"]> {
    return this.json({ id: this.params.id, q: this.request.query.page, body: this.request.body });
  }

  createdJson(): ReturnType<Controller["json"]> {
    return this.json({ ok: true }, 201);
  }

  speak(): ReturnType<Controller["text"]> {
    return this.text("plain words");
  }

  page(): ReturnType<Controller["html"]> {
    return this.html("<p>hi</p>");
  }

  // A 1x1 transparent GIF's leading bytes, including a 0xFF a UTF-8 round trip
  // would mangle — proof the bytes arm carries binary intact.
  icon(): ReturnType<Controller["bytes"]> {
    return this.bytes(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0xff, 0x00]), "image/gif");
  }

  away(): ReturnType<Controller["redirect"]> {
    return this.redirect("/elsewhere");
  }

  permanently(): ReturnType<Controller["redirect"]> {
    return this.redirect("/new-home", 301);
  }

  view(): ReturnType<Controller["renderTree"]> {
    return this.renderTree(greetingRegistry, { type: "Greeting", props: { who: "Ada" } });
  }

  viewNothing(): ReturnType<Controller["renderTree"]> {
    // An unknown component degrades to a null element -> empty body branch.
    return this.renderTree(greetingRegistry, { type: "Unknown" });
  }

  async later(): Promise<ReturnType<Controller["text"]>> {
    await new Promise((resolve) => setTimeout(resolve, 1));

    return this.text("eventually");
  }
}

// A controller with no action methods, to trigger WEB_UNKNOWN_ACTION.
class EmptyController extends Controller {}

const controllers: Record<string, ControllerClass> = {
  probe: ProbeController,
  empty: EmptyController,
};

const buildApp = (): Application => {
  const router = new Router();

  router.get("/probe/:id", "probe#showJson");
  router.post("/created", "probe#createdJson");
  router.get("/speak", "probe#speak");
  router.get("/page", "probe#page");
  router.get("/icon", "probe#icon");
  router.get("/away", "probe#away");
  router.get("/permanently", "probe#permanently");
  router.get("/view", "probe#view");
  router.get("/view-nothing", "probe#viewNothing");
  router.get("/later", "probe#later");
  router.get("/missing-controller", "ghost#index");
  router.get("/missing-action", "empty#nope");
  router.get("/inherited-action", "probe#constructor");

  return new Application({ router, controllers });
};

describe("Controller response helpers", () => {
  it("json defaults to 200 with application/json and a parsed body", async () => {
    const app = buildApp();

    const response = await app.handle("GET", "/probe/7", {
      query: { page: "2" },
      body: { note: "hi" },
    });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");

    expect(JSON.parse(response.body)).toEqual({
      id: "7",
      q: "2",
      body: { note: "hi" },
    });
  });

  it("json honors an explicit status", async () => {
    const app = buildApp();

    const response = await app.handle("POST", "/created");

    expect(response.status).toBe(201);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
  });

  it("text defaults to 200 with text/plain", async () => {
    const app = buildApp();

    const response = await app.handle("GET", "/speak");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/plain");
    expect(response.body).toBe("plain words");
  });

  it("html defaults to 200 with text/html", async () => {
    const app = buildApp();

    const response = await app.handle("GET", "/page");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html");
    expect(response.body).toBe("<p>hi</p>");
  });

  it("bytes returns a Uint8Array body with the caller's content-type, intact", async () => {
    const app = buildApp();

    // `/icon` answers with `bytes(...)`, so its body is a `Uint8Array`. `handle`
    // reports the common string-bodied shape, so we view the response at its true
    // (wider) type to read the bytes — a true cast for an action we control.
    const response: AnyKeelResponse = await app.handle("GET", "/icon");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/gif");

    // The body is raw bytes — not a string — carrying every input byte.
    expect(response.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(response.body as Uint8Array)).toEqual([0x47, 0x49, 0x46, 0x38, 0xff, 0x00]);
  });

  it("redirect defaults to 302 with a Location header", async () => {
    const app = buildApp();

    const response = await app.handle("GET", "/away");

    expect(response.status).toBe(302);
    expect(response.headers.Location).toBe("/elsewhere");
    expect(response.body).toBe("");
  });

  it("redirect honors an explicit status", async () => {
    const app = buildApp();

    const response = await app.handle("GET", "/permanently");

    expect(response.status).toBe(301);
    expect(response.headers.Location).toBe("/new-home");
  });

  it("renderTree SSRs a registry component to HTML", async () => {
    const app = buildApp();

    const response = await app.handle("GET", "/view");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html");
    expect(response.body).toContain("Hello");
    expect(response.body).toContain("Ada");
  });

  it("renderTree yields an empty body when the tree renders to nothing", async () => {
    const app = buildApp();

    const response = await app.handle("GET", "/view-nothing");

    expect(response.status).toBe(200);
    expect(response.body).toBe("");
  });
});

describe("Application dispatch", () => {
  it("awaits an async action", async () => {
    const app = buildApp();

    const response = await app.handle("GET", "/later");

    expect(response.status).toBe(200);
    expect(response.body).toBe("eventually");
  });

  it("returns 404 for an unmatched route", async () => {
    const app = buildApp();

    const response = await app.handle("GET", "/nowhere");

    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toBe("text/plain");
    expect(response.body).toBe("Not Found");
  });

  it("throws WEB_UNKNOWN_CONTROLLER when the controller is not registered", async () => {
    const app = buildApp();

    await expect(app.handle("GET", "/missing-controller")).rejects.toMatchObject({
      code: "WEB_UNKNOWN_CONTROLLER",
    });
  });

  it("throws WEB_UNKNOWN_ACTION when the action method is missing", async () => {
    const app = buildApp();

    let caught: unknown;

    try {
      await app.handle("GET", "/missing-action");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WebError);
    expect((caught as WebError).code).toBe("WEB_UNKNOWN_ACTION");
  });

  it("refuses an action that names an inherited Object built-in", async () => {
    // A typo'd target like `probe#constructor` resolves to an inherited member
    // on every object; it must fail like any unknown action, not invoke it.
    const app = buildApp();

    await expect(app.handle("GET", "/inherited-action")).rejects.toMatchObject({
      code: "WEB_UNKNOWN_ACTION",
    });
  });
});
