import {
  isMonographContentV2,
  iterateSectionBodies,
  type TipTapDoc,
} from "./monographContent.js";

export type TextDiffChunk = {
  type: "same" | "added" | "removed";
  text: string;
};

function textFromTipTapNode(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const record = node as Record<string, unknown>;

  const parts: string[] = [];
  if (typeof record.text === "string") {
    parts.push(record.text);
  }

  const content = Array.isArray(record.content) ? record.content : [];
  for (const child of content) {
    const childText = textFromTipTapNode(child);
    if (childText) parts.push(childText);
  }

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function textFromContent(content: unknown): string {
  if (!content || typeof content !== "object") return "";

  if (isMonographContentV2(content)) {
    return iterateSectionBodies(content)
      .map((chunk) => textFromTipTapNode(chunk.body))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return textFromTipTapNode(content as TipTapDoc);
}

export function textFromHtml(html?: string | null): string {
  if (!html) return "";
  if (typeof window === "undefined") {
    return html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

export function buildWordDiff(before: string, after: string): TextDiffChunk[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  const dp = Array.from({ length: a.length + 1 }, () =>
    Array<number>(b.length + 1).fill(0),
  );

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const aWord = a[i] ?? "";
      const bWord = b[j] ?? "";
      const down = dp[i + 1]?.[j] ?? 0;
      const row = dp[i];
      const right = row?.[j + 1] ?? 0;
      const diagonal = dp[i + 1]?.[j + 1] ?? 0;
      if (!row) continue;
      row[j] = aWord === bWord ? diagonal + 1 : Math.max(down, right);
    }
  }

  const chunks: TextDiffChunk[] = [];
  let i = 0;
  let j = 0;

  function push(type: TextDiffChunk["type"], word: string) {
    const previous = chunks[chunks.length - 1];
    if (previous && previous.type === type) {
      previous.text += ` ${word}`;
      return;
    }
    chunks.push({ type, text: word });
  }

  while (i < a.length && j < b.length) {
    const aWord = a[i] ?? "";
    const bWord = b[j] ?? "";
    const down = dp[i + 1]?.[j] ?? 0;
    const right = dp[i]?.[j + 1] ?? 0;

    if (aWord === bWord) {
      push("same", aWord);
      i += 1;
      j += 1;
    } else if (down >= right) {
      push("removed", aWord);
      i += 1;
    } else {
      push("added", bWord);
      j += 1;
    }
  }

  while (i < a.length) {
    push("removed", a[i] ?? "");
    i += 1;
  }

  while (j < b.length) {
    push("added", b[j] ?? "");
    j += 1;
  }

  return chunks;
}
