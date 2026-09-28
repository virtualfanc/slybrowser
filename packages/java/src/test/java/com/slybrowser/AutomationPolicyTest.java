package com.slybrowser;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class AutomationPolicyTest {
  @Test
  void projectWebDriverIsTheDefaultBackend() {
    AutomationCapability capability = AutomationPolicy.capability();
    assertEquals(AutomationBackend.PROJECT_WEBDRIVER, capability.getBackend());
    assertEquals("java", capability.getLanguage());
    assertNull(capability.getFrameworkVersion());
    assertTrue(capability.hasNativeHumanize());
    assertTrue(capability.hasPersistentContext());
  }

  @Test
  void onlyValidatedPlaywrightLineIsAccepted() {
    assertEquals("1.61.0", AutomationPolicy.validatePlaywrightVersion("1.61.0"));
    ConfigurationException error = assertThrows(
        ConfigurationException.class,
        () -> AutomationPolicy.validatePlaywrightVersion("1.62.0"));
    assertEquals("framework_version_unsupported", error.getCode());
  }

  @Test
  void playwrightAdvertisesNativeHumanizeControlPlane() {
    AutomationCapability capability = AutomationPolicy.capability(
        AutomationBackend.PLAYWRIGHT,
        "1.61.0");
    assertEquals(AutomationBackend.PLAYWRIGHT, capability.getBackend());
    assertEquals("java", capability.getLanguage());
    assertEquals("1.61.0", capability.getFrameworkVersion());
    assertTrue(capability.hasNativeHumanize());
    assertTrue(capability.hasPersistentContext());
  }
}
