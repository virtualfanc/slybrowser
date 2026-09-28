package com.slybrowser;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class ArtifactDownloadPolicyTest {
  @TempDir Path temp;

  @Test
  void retriesTransientStatusAndKeepsOnlyFinalBytes() throws Exception {
    try (LoopbackHttpServer server = new LoopbackHttpServer(503, 200)) {
      Path destination = temp.resolve("artifact.part");
      download(server.url(), destination);
      server.awaitRequests();
      assertArrayEquals("verified".getBytes(StandardCharsets.UTF_8), Files.readAllBytes(destination));
      assertEquals(2, server.attempts());
    }
  }

  @Test
  void doesNotRetryDenial() throws Exception {
    try (LoopbackHttpServer server = new LoopbackHttpServer(403)) {
      Path destination = temp.resolve("denied.part");
      InvocationTargetException error = assertThrows(InvocationTargetException.class,
          () -> download(server.url(), destination));
      server.awaitRequests();
      assertEquals(403, ((LicenseServiceException) error.getCause()).getStatus());
      assertEquals(1, server.attempts());
      assertFalse(Files.exists(destination));
    }
  }

  private static final class LoopbackHttpServer implements AutoCloseable {
    private final ServerSocket socket;
    private final Thread worker;
    private final AtomicInteger attempts = new AtomicInteger();
    private final AtomicReference<Throwable> failure = new AtomicReference<>();

    LoopbackHttpServer(int... statuses) throws Exception {
      socket = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
      socket.setSoTimeout(15000);
      worker = new Thread(() -> {
        try {
          for (int status : statuses) {
            try (Socket peer = socket.accept()) {
              peer.setSoTimeout(15000);
              consumeHeaders(peer.getInputStream());
              attempts.incrementAndGet();
              byte[] body = (status == 200 ? "verified" : "unavailable").getBytes(StandardCharsets.UTF_8);
              byte[] headers = ("HTTP/1.1 " + status + " " + (status == 200 ? "OK" : "Denied") + "\r\n"
                  + "Content-Length: " + body.length + "\r\nConnection: close\r\n\r\n")
                  .getBytes(StandardCharsets.US_ASCII);
              OutputStream output = peer.getOutputStream();
              output.write(headers);
              output.write(body);
              output.flush();
            }
          }
        } catch (Throwable error) {
          failure.set(error);
        }
      }, "sly-java-artifact-http-test");
      worker.setDaemon(true);
      worker.start();
    }

    String url() { return "http://127.0.0.1:" + socket.getLocalPort() + "/archive"; }
    int attempts() { return attempts.get(); }

    void awaitRequests() throws Exception {
      worker.join(15000);
      assertFalse(worker.isAlive(), "Loopback HTTP server did not finish");
      if (failure.get() != null) throw new AssertionError("Loopback HTTP server failed", failure.get());
    }

    @Override
    public void close() throws Exception {
      socket.close();
      worker.join(1000);
    }

    private static void consumeHeaders(InputStream input) throws Exception {
      int matched = 0;
      byte[] terminator = {13, 10, 13, 10};
      while (matched < terminator.length) {
        int value = input.read();
        if (value < 0) throw new AssertionError("HTTP request headers were truncated");
        matched = value == terminator[matched] ? matched + 1 : (value == terminator[0] ? 1 : 0);
      }
    }
  }

  private static void download(String url, Path destination) throws Exception {
    Method method = LicenseServiceClient.class.getDeclaredMethod("defaultArtifactDownloader", String.class, Map.class, Path.class);
    method.setAccessible(true);
    method.invoke(null, url, Map.of(), destination);
  }
}
