# @lesto/i18n

> Internationalization core — message catalogs, interpolation, pluralization. Pure, no deps.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/i18n
```

```ts
import { I18n } from "@lesto/i18n";

const i18n = new I18n({ defaultLocale: "en", locales: { en, fr } });

i18n.t("fr", "greeting", { name: "Ada" }); // interpolates {name}
i18n.plural("en", "cart.items", count);     // CLDR plural rules via Intl.PluralRules
```

Pluralization defers to `Intl.PluralRules`, so locale-correct forms (French
0-is-singular, Russian one/few/many) work with no rule-writing.

### Plain text vs. HTML

`t` / `plural` / `interpolate` return **plain text**: a translation template
and every interpolated param are spliced in verbatim, with no markup encoding.
That is a deliberate contract (the correct encoding depends on the sink — HTML
body, attribute, URL — which only the renderer knows), but it is also a
footgun: writing `t(...)` straight into HTML lets either a compromised/careless
catalog entry or an attacker-controlled param become stored or reflected XSS.

For the common case where the sink **is** an HTML document, use the HTML-safe
variants instead — they escape both the resolved template and every
interpolated param before splicing:

```ts
import { escapeHtml, I18n, interpolateHtml } from "@lesto/i18n";

i18n.tHtml("fr", "greeting", { name: userSuppliedName }); // both sides escaped
i18n.pluralHtml("en", "cart.items", count);
interpolateHtml("<b>{who}</b>", { who: userSuppliedName }); // template + param escaped
escapeHtml(userSuppliedName); // the underlying HTML-escape, if you need it standalone
```

`t`/`plural`/`interpolate` are unchanged — they still return unescaped plain
text for callers who need a different sink's encoding and will apply it
themselves.

[Docs](https://docs.lesto.run) · [Example](../../examples/i18n)
