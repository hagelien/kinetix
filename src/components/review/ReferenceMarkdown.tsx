import { Fragment, type ReactNode } from "react";
import { marked, type Token, type Tokens } from "marked";
import { isSafeMarkdownUrl } from "@/lib/renderMarkdown";
import { ReferenceText } from "./ReferenceText";

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
}

/**
 * Agent-authored markdown (objection reasons, verdict rationales) rendered as
 * React elements rather than raw text, so `**bold**`, `> quotes`, `---` and
 * lists read as formatting instead of literal symbols. Built from marked's
 * token stream — no HTML injection — and plain-text runs go through
 * `ReferenceText`, so "bestridelse #871" and friends stay clickable.
 */
export function ReferenceMarkdown({ text }: { text: string }) {
  const tokens = marked.lexer(text);
  return <div className="space-y-2 leading-snug">{renderBlocks(tokens)}</div>;
}

function renderBlocks(tokens: Token[]): ReactNode[] {
  return tokens.map((token, i) => (
    <Fragment key={i}>{renderBlock(token)}</Fragment>
  ));
}

function renderBlock(token: Token): ReactNode {
  switch (token.type) {
    case "space":
      return null;
    case "paragraph":
      return (
        <p className="whitespace-pre-wrap">
          {renderInline((token as Tokens.Paragraph).tokens)}
        </p>
      );
    case "heading":
      return (
        <p className="font-semibold">
          {renderInline((token as Tokens.Heading).tokens)}
        </p>
      );
    case "blockquote":
      return (
        <blockquote className="space-y-2 border-l-2 border-border pl-2 text-muted-foreground">
          {renderBlocks((token as Tokens.Blockquote).tokens)}
        </blockquote>
      );
    case "hr":
      return <hr className="border-border" />;
    case "code":
      return (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">
          {(token as Tokens.Code).text}
        </pre>
      );
    case "list": {
      const list = token as Tokens.List;
      const items = list.items.map((item, i) => (
        <li
          key={i}
          className={
            item.task ? "flex list-none items-start gap-1.5" : "space-y-1"
          }
        >
          {renderListItem(item)}
        </li>
      ));
      return list.ordered ? (
        <ol
          className="list-decimal space-y-0.5 pl-5"
          start={typeof list.start === "number" ? list.start : undefined}
        >
          {items}
        </ol>
      ) : (
        <ul className="list-disc space-y-0.5 pl-5">{items}</ul>
      );
    }
    case "table": {
      const table = token as Tokens.Table;
      return (
        <div className="overflow-x-auto">
          <table className="border-collapse text-left">
            <thead>
              <tr>
                {table.header.map((cell, i) => (
                  <th
                    key={i}
                    className="border border-border px-1.5 py-0.5 font-medium"
                  >
                    {renderInline(cell.tokens)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className="border border-border px-1.5 py-0.5">
                      {renderInline(cell.tokens)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "text": {
      const t = token as Tokens.Text;
      return (
        <p className="whitespace-pre-wrap">
          {t.tokens ? (
            renderInline(t.tokens)
          ) : (
            <ReferenceText text={decodeEntities(t.text)} />
          )}
        </p>
      );
    }
    default:
      // Raw HTML and anything unrecognised is shown verbatim, never injected.
      return "raw" in token && token.raw.trim() ? (
        <p className="whitespace-pre-wrap">{token.raw}</p>
      ) : null;
  }
}

function renderListItem(item: Tokens.ListItem): ReactNode {
  const body = renderListItemBody(item);
  if (!item.task) return body;
  // Marked strips the `[x]` / `[ ]` marker from the text; keep it visible.
  return (
    <>
      <input
        type="checkbox"
        checked={!!item.checked}
        disabled
        readOnly
        className="mt-[0.2em] shrink-0"
      />
      <div className="min-w-0 space-y-1">{body}</div>
    </>
  );
}

function renderListItemBody(item: Tokens.ListItem): ReactNode {
  // Tight list items wrap their text in a bare `text` block token; render it
  // inline so bullets don't get paragraph spacing.
  if (item.tokens.length === 1 && item.tokens[0]?.type === "text") {
    const t = item.tokens[0] as Tokens.Text;
    return t.tokens ? (
      renderInline(t.tokens)
    ) : (
      <ReferenceText text={decodeEntities(t.text)} />
    );
  }
  return renderBlocks(item.tokens);
}

function renderInline(tokens: Token[], inLink = false): ReactNode[] {
  return tokens.map((token, i) => (
    <Fragment key={i}>{renderInlineToken(token, inLink)}</Fragment>
  ));
}

function renderInlineToken(token: Token, inLink: boolean): ReactNode {
  switch (token.type) {
    case "text": {
      const t = token as Tokens.Text;
      if (t.tokens) return renderInline(t.tokens, inLink);
      const text = decodeEntities(t.text);
      return inLink ? text : <ReferenceText text={text} />;
    }
    case "escape":
      return (token as Tokens.Escape).text;
    case "strong":
      return (
        <strong className="font-semibold">
          {renderInline((token as Tokens.Strong).tokens, inLink)}
        </strong>
      );
    case "em":
      return <em>{renderInline((token as Tokens.Em).tokens, inLink)}</em>;
    case "del":
      return <s>{renderInline((token as Tokens.Del).tokens, inLink)}</s>;
    case "codespan":
      return (
        <code className="rounded bg-muted px-1 font-mono text-[0.95em]">
          {decodeEntities((token as Tokens.Codespan).text)}
        </code>
      );
    case "br":
      return <br />;
    case "link": {
      const link = token as Tokens.Link;
      const children = renderInline(link.tokens, true);
      if (inLink || !isSafeMarkdownUrl(link.href)) return children;
      return (
        <a
          href={link.href}
          title={link.title ?? undefined}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="text-primary underline underline-offset-2"
        >
          {children}
        </a>
      );
    }
    default:
      return "raw" in token ? token.raw : null;
  }
}
