import { fetch as undici_fetch } from "undici";
import { URL } from "node:url";

export interface ProxyConfig {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string[];
  enabled: boolean;
}

/**
 * Parse proxy configuration from environment variables
 * Supports standard proxy environment variable patterns:
 * - HTTP_PROXY, http_proxy
 * - HTTPS_PROXY, https_proxy
 * - NO_PROXY, no_proxy
 */
export function getProxyConfig(): ProxyConfig {
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;

  const noProxyList = noProxy
    ? noProxy.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
    : [];

  return {
    httpProxy,
    httpsProxy,
    noProxy: noProxyList,
    enabled: !!(httpProxy || httpsProxy)
  };
}

/**
 * Check if a URL should bypass proxy based on no_proxy patterns
 * Supports patterns like:
 * - exact domain: example.com
 * - subdomain wildcard: .example.com
 * - localhost variations: localhost, 127.0.0.1
 * - CIDR ranges: 192.168.1.0/24
 */
export function shouldBypassProxy(url: string, noProxyList: string[]): boolean {
  if (!noProxyList.length) return false;

  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    const port = urlObj.port;

    for (const pattern of noProxyList) {
      const cleanPattern = pattern.toLowerCase().trim();

      // Empty pattern matches nothing
      if (!cleanPattern) continue;

      // Wildcard match all
      if (cleanPattern === "*") return true;

      // Exact hostname match
      if (hostname === cleanPattern) return true;

      // Hostname with port match
      if (port && `${hostname}:${port}` === cleanPattern) return true;

      // Domain suffix match (e.g., .example.com matches sub.example.com)
      if (cleanPattern.startsWith(".") && hostname.endsWith(cleanPattern)) {
        return true;
      }

      // Subdomain match (e.g., example.com matches sub.example.com)
      if (hostname.endsWith(`.${cleanPattern}`)) return true;

      // Basic CIDR check for common local ranges (simplified)
      if (isLocalCidrMatch(hostname, cleanPattern)) return true;
    }

    return false;
  } catch {
    // Invalid URL, don't bypass
    return false;
  }
}

/**
 * Simple CIDR matching for common local networks
 * Only handles basic cases like 127.0.0.1/8, 192.168.0.0/16, etc.
 */
function isLocalCidrMatch(hostname: string, pattern: string): boolean {
  // Only handle IP addresses, not hostnames
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;

  // Basic CIDR pattern matching for common cases
  if (pattern.includes("/")) {
    const [network, bits] = pattern.split("/");
    const networkBits = parseInt(bits, 10);

    if (isNaN(networkBits) || networkBits < 0 || networkBits > 32) return false;

    // Simple prefix matching for common cases
    const hostParts = hostname.split(".").map(Number);
    const netParts = network.split(".").map(Number);

    if (hostParts.length !== 4 || netParts.length !== 4) return false;
    if (hostParts.some(isNaN) || netParts.some(isNaN)) return false;

    // Check octets based on CIDR bits
    const octetsToCheck = Math.floor(networkBits / 8);
    const remainingBits = networkBits % 8;

    for (let i = 0; i < octetsToCheck; i++) {
      if (hostParts[i] !== netParts[i]) return false;
    }

    if (remainingBits > 0 && octetsToCheck < 4) {
      const mask = (0xFF << (8 - remainingBits)) & 0xFF;
      if ((hostParts[octetsToCheck] & mask) !== (netParts[octetsToCheck] & mask)) {
        return false;
      }
    }

    return true;
  }

  return false;
}

/**
 * Get the appropriate proxy URL for a given target URL
 */
export function getProxyUrl(targetUrl: string, config: ProxyConfig): string | undefined {
  if (!config.enabled) return undefined;

  if (shouldBypassProxy(targetUrl, config.noProxy || [])) {
    return undefined;
  }

  try {
    const url = new URL(targetUrl);

    if (url.protocol === "https:" && config.httpsProxy) {
      return config.httpsProxy;
    }

    if (url.protocol === "http:" && config.httpProxy) {
      return config.httpProxy;
    }

    // Fallback: use http proxy for https if https proxy not configured
    if (url.protocol === "https:" && !config.httpsProxy && config.httpProxy) {
      return config.httpProxy;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create a proxy-aware fetch function
 * This wraps undici's fetch with automatic proxy configuration
 */
export function createProxyFetch(proxyConfig?: ProxyConfig) {
  const config = proxyConfig || getProxyConfig();

  return async function proxyFetch(url: string | URL, options: any = {}) {
    const targetUrl = url.toString();
    const proxyUrl = getProxyUrl(targetUrl, config);

    if (proxyUrl) {
      // Configure undici dispatcher with proxy
      const fetchOptions = {
        ...options,
        dispatcher: new (await import("undici")).ProxyAgent(proxyUrl)
      };
      return undici_fetch(url, fetchOptions);
    }

    // No proxy needed, use direct fetch
    return undici_fetch(url, options);
  };
}

/**
 * Default proxy-aware fetch instance
 */
export const fetch = createProxyFetch();