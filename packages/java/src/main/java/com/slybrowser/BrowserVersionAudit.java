package com.slybrowser;

public final class BrowserVersionAudit {
  public final String requested;
  public final String selected;
  public final String downloaded;
  public final String launched;
  public final String policy;
  public final String selectionReason;

  public BrowserVersionAudit(
      String requested,
      String selected,
      String downloaded,
      String launched,
      String policy,
      String selectionReason) {
    this.requested = requested;
    this.selected = selected;
    this.downloaded = downloaded;
    this.launched = launched;
    this.policy = policy;
    this.selectionReason = selectionReason;
  }
}
