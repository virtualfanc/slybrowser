package com.slybrowser;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.http.HttpResponse.BodyHandler;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import javax.net.ssl.HttpsURLConnection;
import org.openqa.selenium.remote.http.ClientConfig;
import org.openqa.selenium.remote.http.ConnectionFailedException;
import org.openqa.selenium.remote.http.Contents;
import org.openqa.selenium.remote.http.HttpClient;
import org.openqa.selenium.remote.http.HttpClientName;
import org.openqa.selenium.remote.http.HttpHandler;
import org.openqa.selenium.remote.http.HttpRequest;
import org.openqa.selenium.remote.http.HttpResponse;
import org.openqa.selenium.remote.http.WebSocket;

/**
 * Synchronous WebDriver transport that avoids the JDK selector used by
 * java.net.http.HttpClient. Some supported Windows hosts disable AF_UNIX,
 * which otherwise prevents Selenium from creating its default client.
 */
final class UrlConnectionHttpClient implements HttpClient {
  private final ClientConfig config;
  private final HttpHandler handler;

  private UrlConnectionHttpClient(ClientConfig config) {
    this.config = config;
    this.handler = config.filter().apply(this::executeDirect);
  }

  @Override
  public HttpResponse execute(HttpRequest request) throws UncheckedIOException {
    return handler.execute(request);
  }

  private HttpResponse executeDirect(HttpRequest request) throws UncheckedIOException {
    HttpURLConnection connection = null;
    try {
      URI target = config.baseUri().resolve(request.getUri());
      connection = (HttpURLConnection) (config.proxy() == null
          ? target.toURL().openConnection()
          : target.toURL().openConnection(config.proxy()));
      connection.setRequestMethod(request.getMethod().toString());
      connection.setInstanceFollowRedirects(false);
      connection.setConnectTimeout(timeoutMillis(config.connectionTimeout()));
      connection.setReadTimeout(timeoutMillis(config.readTimeout()));
      if (connection instanceof HttpsURLConnection) {
        ((HttpsURLConnection) connection).setSSLSocketFactory(config.sslContext().getSocketFactory());
      }
      request.forEachHeader(connection::addRequestProperty);
      byte[] body = Contents.bytes(request.getContent());
      if (body.length > 0) {
        connection.setDoOutput(true);
        connection.setFixedLengthStreamingMode(body.length);
        try (OutputStream output = connection.getOutputStream()) {
          output.write(body);
        }
      }
      int status = connection.getResponseCode();
      HttpResponse response = new HttpResponse().setStatus(status);
      connection.getHeaderFields().forEach((name, values) -> {
        if (name != null && values != null) values.forEach(value -> response.addHeader(name, value));
      });
      try (InputStream input = responseStream(connection, status)) {
        response.setContent(Contents.bytes(input == null ? new byte[0] : input.readAllBytes()));
      }
      return response;
    } catch (IOException error) {
      throw new UncheckedIOException(error);
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  @Override
  public WebSocket openSocket(HttpRequest request, WebSocket.Listener listener) {
    throw new ConnectionFailedException("WebSocket transport is unavailable on this host");
  }

  @Override
  public <T> CompletableFuture<java.net.http.HttpResponse<T>> sendAsyncNative(
      java.net.http.HttpRequest request,
      BodyHandler<T> handler) {
    throw new UnsupportedOperationException("Native async HTTP transport is not available through URLConnection");
  }

  @Override
  public <T> java.net.http.HttpResponse<T> sendNative(
      java.net.http.HttpRequest request,
      BodyHandler<T> handler) {
    throw new UnsupportedOperationException("Native HTTP transport is not available through URLConnection");
  }

  private static int timeoutMillis(Duration value) {
    long millis = value.toMillis();
    return (int) Math.min(Integer.MAX_VALUE, Math.max(1, millis));
  }

  private static InputStream responseStream(HttpURLConnection connection, int status) throws IOException {
    if (status >= 400) {
      InputStream error = connection.getErrorStream();
      return error == null ? InputStream.nullInputStream() : error;
    }
    return connection.getInputStream();
  }

  @HttpClientName("sly-compatible-http-client")
  public static final class Factory implements HttpClient.Factory {
    public Factory() {}

    @Override
    public HttpClient createClient(ClientConfig config) {
      try {
        return new org.openqa.selenium.remote.http.jdk.JdkHttpClient.Factory().createClient(config);
      } catch (UncheckedIOException error) {
        return new UrlConnectionHttpClient(config);
      }
    }
  }
}
