package com.slybrowser;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

final class SlyBrowserPublicApiTest {
  @Test
  void exposesOnlyTheUserFacingLaunchFamily() {
    Set<String> methods = Arrays.stream(SlyBrowser.class.getDeclaredMethods())
        .filter(method -> Modifier.isPublic(method.getModifiers()))
        .map(Method::getName)
        .collect(Collectors.toSet());
    assertEquals(Set.of("launch", "launchPlaywright", "launchPlaywrightPersistent"), methods);
  }

  @Test
  void mapsDefaultsToOfficialTrustAndRejectsUnsupportedValues() throws Exception {
    Method mapper = SlyBrowser.class.getDeclaredMethod("licensedSettings", SlyBrowserOptions.class);
    mapper.setAccessible(true);
    LicensedLaunchSettings settings = (LicensedLaunchSettings) mapper.invoke(null, new SlyBrowserOptions());
    assertTrue(settings.trust.licenseTrustedKeys.size() > 0);
    assertTrue(settings.trust.releaseTrustedKeys.size() > 0);
    assertTrue(settings.trust.licenseFileTrustedKeys.size() > 0);
    assertEquals("ephemeral", settings.webdriver.profileMode);

    SlyBrowserOptions invalid = new SlyBrowserOptions();
    invalid.launch.profileMode = "shared";
    ConfigurationException error = assertThrows(
        ConfigurationException.class,
        () -> SlyBrowser.launch(Path.of("account.authorization.json"), invalid));
    assertEquals("launch_options_invalid", error.getCode());
  }
}
