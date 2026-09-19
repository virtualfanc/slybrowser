# SlyBrowser for Java

Use Maven coordinate `com.slybrowser:slybrowser:0.2.0`:

```xml
<dependency>
  <groupId>com.slybrowser</groupId>
  <artifactId>slybrowser</artifactId>
  <version>0.2.0</version>
</dependency>
```

`SlyBrowser.launch()` accepts the authorization file plus optional `profile`, `launch`,
and `humanize` values. No import command is required. The SDK manages release
selection, verification, download, pairing, and temporary state.

```java
import com.slybrowser.SlyBrowser;
import com.slybrowser.SlyBrowserOptions;
import com.slybrowser.SlyWebDriverSession;
import java.nio.file.Path;
import java.util.Map;

SlyBrowserOptions options = new SlyBrowserOptions();
options.profile = Map.of("locale", "en-US");
options.launch.headless = true;
options.humanize.enabled = true;

try (SlyWebDriverSession browser = SlyBrowser.launch(
    Path.of("account.authorization.json"), options)) {
  browser.getDriver().get("https://example.test");
}
```

The default path uses the matched project WebDriver and never falls back to a system
browser. `SlyBrowser.launchPlaywright()` is available when the explicit Playwright
adapter is required.

Unknown or unsupported options, failed authorization, release verification errors,
and browser/driver mismatches stop the launch. Treat the authorization file as a
credential: do not commit, log, or share it.

See the [complete SDK user API](../../docs/user-api.md) for every field and default.
