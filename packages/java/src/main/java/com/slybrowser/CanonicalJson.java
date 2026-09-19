package com.slybrowser;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

final class CanonicalJson {
  static final ObjectMapper MAPPER = new ObjectMapper();

  private CanonicalJson() {}

  static byte[] serialize(JsonNode value) {
    try {
      return MAPPER.writeValueAsBytes(normalize(value));
    } catch (JsonProcessingException error) {
      throw new IllegalArgumentException("Unable to serialize canonical JSON", error);
    }
  }

  static String encodeBase64Url(byte[] value) {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
  }

  static byte[] decodeBase64Url(String value, int maxBytes) {
    if (value == null || value.isEmpty() || !value.matches("^[A-Za-z0-9_-]+$")) {
      throw new IllegalArgumentException("value is not unpadded base64url");
    }
    if (value.length() > ((maxBytes + 2) / 3) * 4) {
      throw new IllegalArgumentException("decoded value exceeds size limit");
    }
    byte[] decoded = Base64.getUrlDecoder().decode(value);
    if (decoded.length > maxBytes) {
      throw new IllegalArgumentException("decoded value exceeds size limit");
    }
    return decoded;
  }

  private static JsonNode normalize(JsonNode value) {
    if (value.isObject()) {
      ObjectNode result = MAPPER.createObjectNode();
      List<String> names = new ArrayList<>();
      Iterator<String> iterator = value.fieldNames();
      while (iterator.hasNext()) names.add(iterator.next());
      names.sort(String::compareTo);
      for (String name : names) result.set(name, normalize(value.get(name)));
      return result;
    }
    if (value.isArray()) {
      ArrayNode result = MAPPER.createArrayNode();
      for (JsonNode item : value) result.add(normalize(item));
      return result;
    }
    return value;
  }

  static ObjectNode object(Map<String, Object> values) {
    return MAPPER.valueToTree(values);
  }
}
