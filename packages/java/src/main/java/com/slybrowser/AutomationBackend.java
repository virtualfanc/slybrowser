package com.slybrowser;

public enum AutomationBackend {
  PROJECT_WEBDRIVER("project-webdriver"),
  PLAYWRIGHT("playwright");

  private final String value;

  AutomationBackend(String value) {
    this.value = value;
  }

  public String value() {
    return value;
  }
}
