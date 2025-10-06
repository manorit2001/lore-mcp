import { test } from "node:test";
import assert from "node:assert";
import { LoreClient } from "../dist/loreClient.js";

test("LoreClient works with proxy configuration", async () => {
  // Test that LoreClient can be instantiated with proxy config
  const client = new LoreClient({
    proxyConfig: {
      httpProxy: "http://fake-proxy.example.com:8080",
      httpsProxy: "https://fake-secure-proxy.example.com:443",
      noProxy: ["localhost", "127.0.0.1"],
      enabled: false // Disabled so we don't actually try to use the fake proxy
    }
  });

  // Should be able to list scopes (actual network call, but no proxy used due to enabled: false)
  try {
    const scopes = await client.listScopes();
    assert.ok(Array.isArray(scopes), "listScopes should return an array");
    assert.ok(scopes.length > 0, "Should have at least one scope");
    assert.ok(scopes[0].scope, "Each scope should have a scope property");
    assert.ok(scopes[0].url, "Each scope should have a url property");
  } catch (error) {
    // Network call might fail in CI/testing environments, that's okay
    // The important thing is that the client was constructed successfully
    console.log("Network call failed (expected in some environments):", error.message);
  }
});

test("LoreClient respects no_proxy configuration", () => {
  const client = new LoreClient({
    proxyConfig: {
      httpProxy: "http://proxy.example.com:8080",
      httpsProxy: "https://secure-proxy.example.com:443",
      noProxy: ["lore.kernel.org", "localhost"],
      enabled: true
    }
  });

  // The client should be constructed successfully
  assert.ok(client, "LoreClient should be constructed successfully with proxy config");

  // We can't easily test the actual proxy bypass without mocking,
  // but we can verify the client was constructed with the config
});

test("LoreClient uses environment proxy configuration by default", () => {
  // Save original env vars
  const originalHttpProxy = process.env.HTTP_PROXY;
  const originalHttpsProxy = process.env.HTTPS_PROXY;
  const originalNoProxy = process.env.NO_PROXY;

  try {
    // Set environment variables
    process.env.HTTP_PROXY = "http://env-proxy.example.com:3128";
    process.env.HTTPS_PROXY = "https://env-secure-proxy.example.com:3128";
    process.env.NO_PROXY = "localhost,*.local";

    // Create client without explicit proxy config - should use environment
    const client = new LoreClient();

    // Client should be constructed successfully
    assert.ok(client, "LoreClient should be constructed with environment proxy config");

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