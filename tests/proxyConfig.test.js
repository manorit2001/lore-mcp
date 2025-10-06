import { test } from "node:test";
import assert from "node:assert";
import { getProxyConfig, shouldBypassProxy, getProxyUrl } from "../dist/proxyConfig.js";

test("getProxyConfig reads environment variables", () => {
  // Save original env vars
  const originalHttpProxy = process.env.HTTP_PROXY;
  const originalHttpsProxy = process.env.HTTPS_PROXY;
  const originalNoProxy = process.env.NO_PROXY;

  try {
    // Test with environment variables set
    process.env.HTTP_PROXY = "http://proxy.example.com:8080";
    process.env.HTTPS_PROXY = "https://secure-proxy.example.com:443";
    process.env.NO_PROXY = "localhost,127.0.0.1,.internal.com";

    const config = getProxyConfig();

    assert.equal(config.httpProxy, "http://proxy.example.com:8080");
    assert.equal(config.httpsProxy, "https://secure-proxy.example.com:443");
    assert.deepEqual(config.noProxy, ["localhost", "127.0.0.1", ".internal.com"]);
    assert.equal(config.enabled, true);
  } finally {
    // Restore original env vars
    if (originalHttpProxy !== undefined) {
      process.env.HTTP_PROXY = originalHttpProxy;
    } else {
      delete process.env.HTTP_PROXY;
    }
    if (originalHttpsProxy !== undefined) {
      process.env.HTTPS_PROXY = originalHttpsProxy;
    } else {
      delete process.env.HTTPS_PROXY;
    }
    if (originalNoProxy !== undefined) {
      process.env.NO_PROXY = originalNoProxy;
    } else {
      delete process.env.NO_PROXY;
    }
  }
});

test("shouldBypassProxy handles various patterns", () => {
  const noProxyList = ["localhost", "127.0.0.1", ".example.com", "192.168.1.0/24"];

  // Should bypass
  assert.equal(shouldBypassProxy("http://localhost:8080", noProxyList), true);
  assert.equal(shouldBypassProxy("https://127.0.0.1", noProxyList), true);
  assert.equal(shouldBypassProxy("http://sub.example.com", noProxyList), true);
  assert.equal(shouldBypassProxy("https://api.example.com", noProxyList), true);
  assert.equal(shouldBypassProxy("http://192.168.1.100", noProxyList), true);

  // Should not bypass
  assert.equal(shouldBypassProxy("https://external.com", noProxyList), false);
  assert.equal(shouldBypassProxy("http://10.0.0.1", noProxyList), false);
  assert.equal(shouldBypassProxy("https://example.org", noProxyList), false);
});

test("getProxyUrl returns correct proxy for protocols", () => {
  const config = {
    httpProxy: "http://proxy.example.com:8080",
    httpsProxy: "https://secure-proxy.example.com:443",
    noProxy: [],
    enabled: true
  };

  // HTTP should use httpProxy
  assert.equal(getProxyUrl("http://test.com", config), "http://proxy.example.com:8080");

  // HTTPS should use httpsProxy
  assert.equal(getProxyUrl("https://test.com", config), "https://secure-proxy.example.com:443");

  // Should return undefined when bypassed
  const configWithNoProxy = { ...config, noProxy: ["test.com"] };
  assert.equal(getProxyUrl("https://test.com", configWithNoProxy), undefined);

  // Should return undefined when disabled
  const disabledConfig = { ...config, enabled: false };
  assert.equal(getProxyUrl("https://test.com", disabledConfig), undefined);
});

test("CIDR matching works for common ranges", () => {
  const noProxyList = ["192.168.0.0/16", "10.0.0.0/8", "127.0.0.0/8"];

  // Should bypass local networks
  assert.equal(shouldBypassProxy("http://192.168.1.100", noProxyList), true);
  assert.equal(shouldBypassProxy("http://192.168.255.1", noProxyList), true);
  assert.equal(shouldBypassProxy("http://10.5.10.20", noProxyList), true);
  assert.equal(shouldBypassProxy("http://127.0.0.1", noProxyList), true);

  // Should not bypass external IPs
  assert.equal(shouldBypassProxy("http://8.8.8.8", noProxyList), false);
  assert.equal(shouldBypassProxy("http://172.16.1.1", noProxyList), false);
});

test("fallback behavior works correctly", () => {
  // Only HTTP proxy configured
  const httpOnlyConfig = {
    httpProxy: "http://proxy.example.com:8080",
    httpsProxy: undefined,
    noProxy: [],
    enabled: true
  };

  // HTTP should use httpProxy
  assert.equal(getProxyUrl("http://test.com", httpOnlyConfig), "http://proxy.example.com:8080");

  // HTTPS should fall back to httpProxy when httpsProxy not configured
  assert.equal(getProxyUrl("https://test.com", httpOnlyConfig), "http://proxy.example.com:8080");

  // Only HTTPS proxy configured
  const httpsOnlyConfig = {
    httpProxy: undefined,
    httpsProxy: "https://secure-proxy.example.com:443",
    noProxy: [],
    enabled: true
  };

  // HTTP should return undefined when no httpProxy
  assert.equal(getProxyUrl("http://test.com", httpsOnlyConfig), undefined);

  // HTTPS should use httpsProxy
  assert.equal(getProxyUrl("https://test.com", httpsOnlyConfig), "https://secure-proxy.example.com:443");
});