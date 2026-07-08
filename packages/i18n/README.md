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
0-is-singular, Russian one/few/many) work with no rule-writing. Interpolation is
plain text — escape at your HTML sink.

[Docs](https://docs.lesto.run) · [Example](../../examples/i18n)
