import type { Message, MessageHeaders } from "./messageTypes.js";

function parseHeaders(headerText: string): MessageHeaders {
  const lines = headerText.split(/\r?\n/);
  const headers: MessageHeaders = {};
  let current: string | null = null;
  for (const line of lines) {
    if (/^\s/.test(line) && current) {
      // continuation line, fold into previous header value
      const prev = headers[current];
      const append = line.trim();
      if (Array.isArray(prev)) {
        headers[current] = [...prev.slice(0, -1), `${prev[prev.length - 1]} ${append}`];
      } else if (typeof prev === "string") {
        headers[current] = `${prev} ${append}`;
      }
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) {
      current = null;
      continue;
    }
    const name = line.slice(0, idx).toLowerCase();
    const value = line.slice(idx + 1).trim();
    const existing = headers[name];
    if (existing === undefined) {
      headers[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      headers[name] = [existing, value];
    }
    current = name;
  }
  return headers;
}

export function parseRfc822(raw: string): Message {
  const sep = /\r?\n\r?\n/;
  const match = raw.match(sep);
  if (!match) {
    return { headers: {}, body: raw };
  }
  const idx = match.index ?? 0;
  const headerText = raw.slice(0, idx);
  const body = raw.slice(idx + match[0].length);
  return { headers: parseHeaders(headerText), body };
}

export function parseMbox(mbox: string): Message[] {
  const lines = mbox.split(/\r?\n/);
  const rawMessages: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("From ") && current.length > 0) {
      rawMessages.push(current.join("\n"));
      current = [];
      continue;
    }
    if (line.startsWith("From ") && current.length === 0) {
      continue; // skip separator line
    }
    current.push(line);
  }
  if (current.length > 0) {
    rawMessages.push(current.join("\n"));
  }
  return rawMessages.map(parseRfc822);
}
