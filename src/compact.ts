import type { Message } from "./messageTypes.js";

export type TrailerLine = {
  key: string;
  value: string;
  line: string;
};

export type DiffStat = {
  files: number;
  insertions: number;
  deletions: number;
  perFile: { file: string; insertions: number; deletions: number }[];
};

export type ExtractDiffOptions = {
  maxFiles?: number; // max files to include (by size)
  maxHunksPerFile?: number; // per file hunk cap
  maxHunkLines?: number; // per hunk line cap (after header)
};

export type ThreadSummaryOptions = {
  maxMessages?: number;
  stripQuoted?: boolean;
  shortBodyBytes?: number;
};

// Normalized, header-only, de-duplicated summary to minimize redundancy/size
export type NormalizedThreadSummary = {
  thread: {
    subject: string;
    subject_base: string;
    total_messages: number;
    patch_series?: { version?: string; total?: number } | null;
  };
  participants: { id: number; name: string; messages: number }[];
  subjects: string[]; // pool of de-duplicated (normalized) subjects
  items: { id: number; mid?: string; date?: string; from: number; subject: number }[];
};

function normalizeSubjectRaw(subject: string): string {
  let s = subject || "";
  // Drop common prefixes (Re:, Fwd:, Aw:, etc.) repeatedly
  for (;;) {
    const next = s.replace(/^\s*(re|fwd|aw|sv|antw):\s*/i, "");
    if (next === s) break; s = next;
  }
  // Remove bracket tags like [PATCH v2 1/3], [RFC], [RESEND]
  s = s.replace(/\[[^\]]+\]\s*/g, "");
  return s.trim().replace(/\s+/g, " ");
}

export function summarizeThreadNormalized(messages: Message[], opts: { maxMessages?: number } = {}): NormalizedThreadSummary {
  const { maxMessages = messages.length } = opts;
  const msgs = messages.slice(0, maxMessages);
  const firstSubj = getHeader(msgs[0]?.headers || {}, "subject") || "";
  const subjBase = normalizeSubjectRaw(firstSubj);
  const { version, total } = parsePatchSubject(firstSubj);

  // Pools
  const subjectPool: string[] = [];
  const subjectIndex = new Map<string, number>();
  const authorCounts = new Map<string, number>();
  const itemsTmp: { id: number; mid?: string; date?: string; fromName: string; subjectNorm: string }[] = [];

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const subject = getHeader(m.headers, "subject") || "";
    const from = getHeader(m.headers, "from") || "";
    const date = getHeader(m.headers, "date") || undefined;
    const mid = getHeader(m.headers, "message-id") || m.messageId || undefined;
    const subjectNorm = normalizeSubjectRaw(subject);
    let si = subjectIndex.get(subjectNorm);
    if (si === undefined) { si = subjectPool.push(subjectNorm) - 1; subjectIndex.set(subjectNorm, si); }
    authorCounts.set(from, (authorCounts.get(from) || 0) + 1);
    itemsTmp.push({ id: i, mid, date, fromName: from, subjectNorm });
  }

  // Build participants sorted by message count desc and re-index items
  const participantsSorted = Array.from(authorCounts.entries())
    .map(([name, messages]) => ({ name, messages }))
    .sort((a, b) => b.messages - a.messages);
  const authorToId = new Map<string, number>();
  const participants = participantsSorted.map((p, idx) => {
    authorToId.set(p.name, idx);
    return { id: idx, name: p.name, messages: p.messages };
  });

  const items = itemsTmp.map((it) => ({
    id: it.id,
    mid: it.mid,
    date: it.date,
    from: authorToId.get(it.fromName) ?? 0,
    subject: subjectIndex.get(it.subjectNorm) ?? 0,
  }));

  return {
    thread: {
      subject: firstSubj,
      subject_base: subjBase,
      total_messages: msgs.length,
      patch_series: version || total ? { version, total } : null,
    },
    participants,
    subjects: subjectPool,
    items,
  };
}

export type CompactPatchsetOptions = ExtractDiffOptions & {
  includeDiffs?: boolean; // include truncated diffs
  statOnly?: boolean; // return only stats
};

export type Patchset = {
  series: {
    subject: string;
    version?: string; // v1, v2, ...
    parts?: { index: number; total: number } | null;
  };
  coverLetter?: {
    subject: string;
    messageId?: string;
    url?: string;
  };
  patches: {
    subject: string;
    messageId?: string;
    url?: string;
    diffStat?: DiffStat;
    diffs?: string[];
  }[];
  aggregate?: DiffStat;
};

export function estimateTokens(text: string): number {
  // Rough heuristic: ~4 characters per token for English/plain text
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function getHeader(headers: Record<string, string | string[]>, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  if (typeof v === "string") return v;
  return undefined;
}

export function stripQuoted(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let inQuoteBlock = false;
  let inSignature = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // Always drop raw quoted lines
    if (/^>/.test(l)) continue;
    // Handle common quote-introducers
    if (/^On .+ wrote:/.test(l)) { inQuoteBlock = true; continue; }
    if (/^-----Original Message-----/.test(l)) { inQuoteBlock = true; continue; }
    if (/^From:.+\@.+/.test(l) && /Sent:|To:|Subject:/i.test(lines[i + 1] || "")) { inQuoteBlock = true; continue; }
    if (/^_{3,}/.test(l)) { inQuoteBlock = true; continue; }
    // PGP signatures
    if (/^-----BEGIN PGP SIGNATURE-----/.test(l)) { inSignature = true; continue; }
    if (/^-----END PGP SIGNATURE-----/.test(l)) { inSignature = false; continue; }
    // Signature separator; stop unless a diff starts later
    if (/^--\s*$/.test(l)) {
      const rest = lines.slice(i + 1).join("\n");
      if (!/\n?diff --git /.test(rest)) break;
    }
    // End of quote block: first non-empty, non-quoted content resumes normal output
    if (inQuoteBlock) {
      if (l.trim() === "") continue; // still inside quoted context padding
      // non-empty and not quoted: treat as new content
      inQuoteBlock = false;
    }
    if (inSignature) continue;
    out.push(l);
  }
  return out.join("\n");
}

export function extractTrailers(body: string): TrailerLine[] {
  const keys = [
    "Fixes",
    "Reported-by",
    "Suggested-by",
    "Reviewed-by",
    "Acked-by",
    "Tested-by",
    "Cc",
    "Link",
    "Signed-off-by",
  ];
  const set = new Set(keys.map((k) => k.toLowerCase()));
  const out: TrailerLine[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z-]+):\s*(.+)$/);
    if (!m) continue;
    const k = m[1];
    if (!set.has(k.toLowerCase())) continue;
    out.push({ key: k, value: m[2].trim(), line });
  }
  return out;
}

export function extractDiffBlocks(body: string): string[] {
  const blocks: string[] = [];
  const lines = body.split(/\r?\n/);
  let current: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^diff --git /.test(l)) {
      if (current) blocks.push(current.join("\n"));
      current = [l];
    } else if (current) {
      current.push(l);
    }
  }
  if (current) blocks.push(current.join("\n"));
  return blocks;
}

export function computeDiffStat(diff: string): { stat: DiffStat; byFile: Map<string, { ins: number; del: number; size: number }> } {
  const perFile = new Map<string, { ins: number; del: number; size: number }>();
  let currentFile: string | null = null;
  const lines = diff.split(/\r?\n/);
  for (const l of lines) {
    const m1 = l.match(/^\+\+\+ b\/(.+)$/);
    if (m1) { currentFile = m1[1]; continue; }
    const m2 = l.match(/^--- a\/(.+)$/);
    if (m2 && !currentFile) { currentFile = m2[1]; continue; }
    if (/^Binary files /.test(l)) { currentFile = null; continue; }
    if (/^\+/.test(l) && !/^\+\+\+/.test(l)) {
      if (currentFile) {
        const e = perFile.get(currentFile) || { ins: 0, del: 0, size: 0 };
        e.ins++; e.size++;
        perFile.set(currentFile, e);
      }
    } else if (/^-/.test(l) && !/^---/.test(l)) {
      if (currentFile) {
        const e = perFile.get(currentFile) || { ins: 0, del: 0, size: 0 };
        e.del++; e.size++;
        perFile.set(currentFile, e);
      }
    }
  }
  let files = 0, insertions = 0, deletions = 0;
  const outPerFile: { file: string; insertions: number; deletions: number }[] = [];
  for (const [file, v] of perFile) {
    files++; insertions += v.ins; deletions += v.del;
    outPerFile.push({ file, insertions: v.ins, deletions: v.del });
  }
  const stat: DiffStat = { files, insertions, deletions, perFile: outPerFile };
  return { stat, byFile: perFile };
}

function truncateByHunks(diff: string, maxHunksPerFile = 3, maxHunkLines = 80): string {
  const lines = diff.split(/\r?\n/);
  const out: string[] = [];
  let hunks = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^@@ /.test(l)) {
      hunks++;
      if (hunks > maxHunksPerFile) break;
      out.push(l);
      let used = 0;
      for (let j = i + 1; j < lines.length; j++) {
        const s = lines[j];
        if (/^@@ /.test(s)) { i = j - 1; break; }
        if (used < maxHunkLines) { out.push(s); used++; }
        else { i = j - 1; break; }
      }
      continue;
    }
    // include headers and file markers
    if (/^(diff --git |index |--- a\/|\+\+\+ b\/)/.test(l)) out.push(l);
  }
  return out.join("\n");
}

export function extractDiffs(body: string, opts: ExtractDiffOptions = {}): { diffs: string[]; stat: DiffStat } {
  const { maxFiles = 10, maxHunksPerFile = 3, maxHunkLines = 80 } = opts;
  const blocks = extractDiffBlocks(body);
  const stats = blocks.map((b) => ({ block: b, meta: computeDiffStat(b) }));
  stats.sort((a, b) => (b.meta.stat.insertions + b.meta.stat.deletions) - (a.meta.stat.insertions + a.meta.stat.deletions));
  const chosen = stats.slice(0, maxFiles);
  const diffs = chosen.map(({ block }) => truncateByHunks(block, maxHunksPerFile, maxHunkLines));
  // aggregate stat across all (not just chosen) to represent full series/file impact
  let files = 0, insertions = 0, deletions = 0;
  const per = new Map<string, { ins: number; del: number }>();
  for (const s of stats) {
    const { perFile } = s.meta.stat;
    for (const f of perFile) {
      const e = per.get(f.file) || { ins: 0, del: 0 };
      e.ins += f.insertions; e.del += f.deletions;
      per.set(f.file, e);
    }
  }
  const perFile: { file: string; insertions: number; deletions: number }[] = [];
  for (const [file, v] of per) { files++; insertions += v.ins; deletions += v.del; perFile.push({ file, insertions: v.ins, deletions: v.del }); }
  const stat: DiffStat = { files, insertions, deletions, perFile };
  return { diffs, stat };
}

export function detectPatchKind(msg: Message): "cover" | "patch" | "reply" {
  const subj = (getHeader(msg.headers, "subject") || "").toLowerCase();
  if (/\[patch/.test(subj)) {
    if (/\b0\/(\d+)\b/.test(subj)) return "cover";
    return "patch";
  }
  if (/^diff --git /m.test(msg.body)) return "patch";
  return "reply";
}

export function summarizeThread(messages: Message[], opts: ThreadSummaryOptions = {}) {
  const { maxMessages = 50, stripQuoted: doStrip = true, shortBodyBytes = 1200 } = opts;
  const items = messages.slice(0, maxMessages).map((m) => {
    const subject = getHeader(m.headers, "subject") || "";
    const from = getHeader(m.headers, "from");
    const date = getHeader(m.headers, "date");
    const messageId = getHeader(m.headers, "message-id") || m.messageId;
    const kind = detectPatchKind(m);
    const rawBody = doStrip ? stripQuoted(m.body) : m.body;
    const body = rawBody.length > shortBodyBytes ? rawBody.slice(0, shortBodyBytes) + `\n...[truncated ${rawBody.length - shortBodyBytes} bytes]` : rawBody;
    const trailers = extractTrailers(m.body);
    const hasDiff = /^diff --git /m.test(m.body);
    return { subject, from, date, messageId, kind, body, hasDiff, trailers };
  });
  return { items };
}

export function parsePatchSubject(subject: string): { base: string; version?: string; index?: number; total?: number } {
  // Examples: [PATCH v2 0/3] cover; [PATCH v3 2/7] foo; [PATCH 1/2] bar; [PATCH v4] baz
  const m = subject.match(/\[\s*patch\s*(v\d+)?\s*(\d+)\/(\d+)\s*\]/i);
  if (m) {
    const version = m[1] || undefined;
    const index = Number(m[2]);
    const total = Number(m[3]);
    const base = subject.replace(/\[\s*patch[^\]]*\]/i, "").trim();
    return { base, version, index, total };
  }
  const m2 = subject.match(/\[\s*patch\s*(v\d+)?\s*\]/i);
  if (m2) {
    const version = m2[1] || undefined;
    const base = subject.replace(/\[\s*patch[^\]]*\]/i, "").trim();
    return { base, version };
  }
  return { base: subject };
}

export function buildPatchset(messages: Message[], opts: CompactPatchsetOptions = {}): Patchset | null {
  const patchMsgs = messages.filter((m) => detectPatchKind(m) !== "reply");
  if (patchMsgs.length === 0) return null;
  const subjects = patchMsgs.map((m) => getHeader(m.headers, "subject") || "");
  const parsed = subjects.map(parsePatchSubject);
  // choose the most common base as series subject
  const counts = new Map<string, number>();
  parsed.forEach((p) => counts.set(p.base, (counts.get(p.base) || 0) + 1));
  let seriesBase = subjects[0];
  let maxCount = 0;
  for (const [k, v] of counts) { if (v > maxCount) { seriesBase = k; maxCount = v; } }
  // choose highest version present
  let version: string | undefined;
  for (const p of parsed) {
    if (p.version) {
      if (!version) version = p.version;
      else {
        const n = Number(p.version.replace(/v/i, ""));
        const cur = Number(version.replace(/v/i, ""));
        if (n > cur) version = p.version;
      }
    }
  }
  // detect parts based on any subject with index/total
  const withParts = parsed.find((p) => typeof p.index === "number" && typeof p.total === "number");
  const parts = withParts ? { index: withParts.index || 0, total: withParts.total || patchMsgs.length } : null;

  const cover = patchMsgs.find((m, i) => (parsed[i].index === 0));
  const { includeDiffs = false, statOnly = false } = opts;
  const patches = patchMsgs
    .filter((m, i) => parsed[i].index !== 0) // exclude cover from patches list
    .map((m) => {
      const subject = getHeader(m.headers, "subject") || "";
      const messageId = getHeader(m.headers, "message-id") || m.messageId;
      const url = (m as any).url; // optional
      let diffStat: DiffStat | undefined;
      let diffs: string[] | undefined;
      if (!statOnly) {
        const { stat, diffs: ds } = extractDiffs(m.body, opts);
        diffStat = stat;
        if (includeDiffs) diffs = ds;
      } else {
        const blocks = extractDiffBlocks(m.body);
        const agg = blocks.map((b) => computeDiffStat(b).stat);
        let files = 0, insertions = 0, deletions = 0;
        const per = new Map<string, { ins: number; del: number }>();
        for (const s of agg) {
          for (const f of s.perFile) {
            const e = per.get(f.file) || { ins: 0, del: 0 };
            e.ins += f.insertions; e.del += f.deletions;
            per.set(f.file, e);
          }
        }
        const perFile: { file: string; insertions: number; deletions: number }[] = [];
        for (const [file, v] of per) { files++; insertions += v.ins; deletions += v.del; perFile.push({ file, insertions: v.ins, deletions: v.del }); }
        diffStat = { files, insertions, deletions, perFile };
      }
      return { subject, messageId, url, diffStat, diffs };
    });

  // aggregate across patches
  let aggFiles = 0, aggIns = 0, aggDel = 0;
  const perAgg = new Map<string, { ins: number; del: number }>();
  for (const p of patches) {
    if (!p.diffStat) continue;
    for (const f of p.diffStat.perFile) {
      const e = perAgg.get(f.file) || { ins: 0, del: 0 };
      e.ins += f.insertions; e.del += f.deletions;
      perAgg.set(f.file, e);
    }
  }
  const perFileAgg: { file: string; insertions: number; deletions: number }[] = [];
  for (const [file, v] of perAgg) { aggFiles++; aggIns += v.ins; aggDel += v.del; perFileAgg.push({ file, insertions: v.ins, deletions: v.del }); }

  const patchset: Patchset = {
    series: { subject: seriesBase, version, parts },
    coverLetter: cover ? {
      subject: getHeader(cover.headers, "subject") || "",
      messageId: getHeader(cover.headers, "message-id") || cover.messageId,
      url: (cover as any).url,
    } : undefined,
    patches,
    aggregate: { files: aggFiles, insertions: aggIns, deletions: aggDel, perFile: perFileAgg },
  };
  return patchset;
}

// Apply a soft token budget to a thread summary by trimming bodies and dropping
// tail items. Allows up to 10% overflow to avoid over-truncation.
export function applyTokenBudgetToThreadSummary(
  summary: ReturnType<typeof summarizeThread>,
  tokenBudget: number,
  opts: { basePerItem?: number; overflowAllowance?: number } = {}
) {
  const basePerItem = opts.basePerItem ?? 24; // subject/from/date/kind/trailers metadata
  const overflowAllowance = opts.overflowAllowance ?? 0.10; // 10%
  const hardLimit = Math.floor(tokenBudget * (1 + overflowAllowance));
  const out: typeof summary.items = [];
  let used = 0;
  for (const it of summary.items) {
    const headCost = basePerItem + estimateTokens(it.subject || "") / 2; // subject counted partially
    const bodyCost = estimateTokens(it.body || "");
    if (used + headCost >= hardLimit) break;
    let newBody = it.body || "";
    let addCost = headCost + bodyCost;
    if (used + addCost > hardLimit) {
      // Trim body to fit remaining budget
      const remaining = Math.max(0, hardLimit - used - headCost);
      const chars = Math.max(0, remaining * 4);
      if (chars < newBody.length) {
        const left = newBody.length - chars;
        newBody = newBody.slice(0, chars) + `\n...[truncated ${left} bytes]`;
        addCost = headCost + estimateTokens(newBody);
      }
    }
    used += addCost;
    out.push({ ...it, body: newBody });
  }
  return { items: out };
}

// Apply a soft token budget to a patchset with diffs by pruning/trimming diffs.
export function applyTokenBudgetToPatchset(
  patchset: Patchset,
  tokenBudget: number,
  opts: { basePerPatch?: number; overflowAllowance?: number } = {}
) {
  const basePerPatch = opts.basePerPatch ?? 40; // metadata + stat
  const overflowAllowance = opts.overflowAllowance ?? 0.10;
  const hardLimit = Math.floor(tokenBudget * (1 + overflowAllowance));
  let used = 0;
  const patches = patchset.patches.map((p) => ({ ...p }));
  for (const p of patches) {
    const metaCost = basePerPatch + estimateTokens(p.subject || "") / 2;
    if (used + metaCost >= hardLimit) { p.diffs = []; continue; }
    used += metaCost;
    const diffs = (p.diffs || []).slice();
    const newDiffs: string[] = [];
    for (const d of diffs) {
      const cost = estimateTokens(d);
      if (used + cost <= hardLimit) {
        newDiffs.push(d);
        used += cost;
      } else {
        const remaining = Math.max(0, hardLimit - used);
        if (remaining <= 0) break;
        const chars = remaining * 4;
        if (chars > 0) {
          const d2 = d.slice(0, chars) + `\n...[truncated ${d.length - chars} bytes]`;
          newDiffs.push(d2);
          used += estimateTokens(d2);
        }
        break;
      }
    }
    p.diffs = newDiffs;
  }
  return { ...patchset, patches };
}
