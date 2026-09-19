# SlyBrowser for Node.js

```sh
npm install slybrowser@0.2.0
```

This npm package is the Node.js SDK. The same 0.2.0 launch contract is also available
for [Python](https://pypi.org/project/slybrowser/),
[Java](https://central.sonatype.com/artifact/com.slybrowser/slybrowser), and
[.NET](https://www.nuget.org/packages/SlyBrowser).

`launch()` accepts the authorization file plus optional `profile`, `launch`, and
`humanize` values. No import command is required. The SDK manages release selection,
verification, download, pairing, and temporary state.

```ts
import { launch } from "slybrowser";

await using browser = await launch("account.authorization.json", {
  profile: { locale: "en-US", screen: { width: 1440, height: 900 } },
  launch: { headless: true, profileMode: "ephemeral", updateKernel: true },
  humanize: { enabled: true, preset: "default" },
});

await browser.get("https://example.test");
console.log(await browser.title());
```

The default path uses the matched project WebDriver and never falls back to a system
browser. Use `launchPlaywright()` or `launchPuppeteer()` only when an explicit adapter
is required. Persistent adapter variants are also available.

Unknown or unsupported options, failed authorization, release verification errors,
and browser/driver mismatches stop the launch. Treat the authorization file as a
credential: do not commit, log, or share it.

See the [complete SDK user API](../../docs/user-api.md) for every field and default.
