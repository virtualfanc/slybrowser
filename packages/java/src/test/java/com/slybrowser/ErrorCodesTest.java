package com.slybrowser;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import org.junit.jupiter.api.Test;

class ErrorCodesTest {
  @Test
  void licenseServiceErrorCodesMatchSharedContract() throws Exception {
    JsonNode root = new ObjectMapper().readTree(
        Path.of("..", "..", "contracts", "error-codes.json").toFile());
    List<String> codes = new ArrayList<>();
    for (JsonNode entry : root.get("codes")) {
      codes.add(entry.get("code").asText());
    }
    assertEquals(codes, ErrorCodes.LICENSE_SERVICE);
    assertEquals(codes.size(), new HashSet<>(codes).size());
    assertTrue(ErrorCodes.isLicenseServiceErrorCode("session_limit"));
    assertFalse(ErrorCodes.isLicenseServiceErrorCode("not_a_slybrowser_error"));
  }
}
