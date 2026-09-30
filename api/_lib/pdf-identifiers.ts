/**
 * Read a paper's own identifiers out of the PDF the human dropped in.
 *
 * This is the half of the bulk-drop feature that saves the time. A folder of
 * downloads is anonymous to the system but not to the file: a modern article
 * carries its DOI in the XMP metadata packet the publisher writes, in the
 * document Info dictionary, and stamped in the running head of page one; a
 * PubMed Central download carries "PMCID: PMC…" / "PMID: …" in the footer;
 * and a download saved through a library proxy or a reference manager is
 * usually *named* after its DOI or its first author and year. So in the common
 * case nobody has to identify anything by eye.
 *
 * ## Why this is hand-rolled rather than a PDF library
 *
 * Nothing here needs to render, lay out, or faithfully decode a PDF — it needs
 * to find a DOI-shaped string. A full parser (pdfjs-dist, unpdf, mupdf) costs
 * megabytes in a serverless bundle and brings a font/rendering stack along for
 * a job that is three regexes and `zlib.inflateSync`, which Node already has.
 * The trade is accepted deliberately and its cost is bounded: when the scan
 * finds nothing, the item simply lands in the inbox unmatched and a human or
 * an agent links it — exactly the state it would have been in without this
 * module. Extraction is an accelerator, never a gate.
 *
 * What it therefore does NOT attempt: cross-reference tables, object streams
 * (`/ObjStm`), encrypted documents, or correct text extraction through custom
 * font encodings. A paper stored as a bare scan has no text layer to read at
 * all, and no library would change that either.
 *
 * ## Trust
 *
 * Everything returned here is a *claim the file makes about itself*, read from
 * an artifact a third party produced. It is never treated as proof: an
 * extracted identifier only ever selects a candidate row, and what makes an
 * attachment correct is that the identifier resolves to exactly one citation
 * (see `pdf-inbox-match.ts`). The known failure mode is real — a preprint or a
 * supplementary file often carries the *published* article's DOI — which is
 * why an auto-attach is recorded as such and remains reversible.
 */
import { inflateSync } from 'node:zlib';

/** What a file claims about itself, with the evidence for each claim. */
export interface ExtractedIdentifiers {
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  title: string | null;
  year: number | null;
  /**
   * Where each field came from, strongest evidence first. Surfaced in the
   * inbox UI so a reviewer judging a doubtful match can see whether the DOI
   * was stamped in the document metadata or merely guessed from a filename.
   */
  sources: Partial<Record<keyof Omit<ExtractedIdentifiers, 'sources'>, IdentifierSource>>;
}

export type IdentifierSource =
  | 'filename'
  /** The XMP metadata packet a publisher writes into the file. */
  | 'xmp'
  /** The document Info dictionary (`/Title`, `/Subject`, `/Keywords`). */
  | 'info'
  /** Text read off the page — the running head, the footer, the first page. */
  | 'text'
  /**
   * Found loose in the file's uncompressed bytes, in no identified object.
   *
   * Deliberately its own source rather than folded into `text`, because it
   * carries no claim about *where* in the document it came from. The
   * uncompressed region holds every object the producer did not compress —
   * including the link annotations behind a reference list, which are other
   * papers' DOIs. So this can never settle an identity on its own; like a
   * filename, it proposes.
   */
  | 'raw';

/**
 * How much of an uploaded file the scanner will look at.
 *
 * Everything this module is after lives in the first pages and in the metadata
 * packet, both of which sit near the front of a linearised (web-optimised) PDF
 * — which publisher PDFs are, precisely so a reader can show page one before
 * the rest arrives. A 50 MB supplement-heavy paper is therefore fully served
 * by reading its first few megabytes, and capping keeps the scan inside a
 * serverless function's time and memory budget no matter what gets dropped in.
 */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
/** Compressed streams to inflate before giving up. */
const MAX_STREAMS = 40;
/** Ceiling on a single inflated stream — a decompression bomb stops here. */
const MAX_INFLATED_BYTES = 4 * 1024 * 1024;
/**
 * Total inflated bytes across all streams in one file.
 *
 * Also the ceiling on how much text is held in memory at once, since the
 * decoded operands are joined into a single string before scanning. Page one
 * of a typeset article is a few hundred kilobytes decompressed, so this is
 * already an order of magnitude more than the job needs — it exists to stop a
 * pathological file, not to serve a legitimate one.
 */
const MAX_TOTAL_INFLATED_BYTES = 8 * 1024 * 1024;

/**
 * A DOI as it appears in running text.
 *
 * Deliberately permissive on the suffix (the registrant may use almost any
 * printable character) and strict on the prefix (`10.` + a 4-9 digit
 * registrant code), because the prefix is what makes the pattern specific
 * enough to run over arbitrary decompressed bytes without drowning in false
 * positives. Trailing punctuation is stripped afterwards by
 * {@link cleanDoi} — a DOI at the end of a sentence otherwise swallows the
 * full stop.
 */
const DOI_PATTERN = /\b10\.\d{4,9}\/[-._;()/:a-z0-9<>+\[\]]+/gi;

/**
 * A PMID, but only where the document says it is one.
 *
 * An eight-digit number on its own is not evidence of anything — it is a page
 * count, a phone number, an accession, a year range. Only the labelled form is
 * accepted, which is how PubMed and PMC actually stamp it.
 *
 * The separator class is wider than the printed `PMID: 12345678` because the
 * label survives into filenames, where a colon and a space cannot: `pmid_…`
 * and `pmid-…` are what a download saved through PubMed actually looks like on
 * disk, and those are exactly the files this has to identify.
 */
const PMID_PATTERN = /\bPMID[\s:_-]*(\d{1,8})\b/gi;

const PMCID_PATTERN = /\bPMC[\s:_-]*(\d{6,9})\b/gi;

/**
 * Longest string this will accept as a DOI.
 *
 * The suffix pattern has to be permissive (a registrant may use almost any
 * printable character), which means a run of matching bytes in a malformed or
 * hostile file can extend it indefinitely. Real DOIs are short; the longest in
 * circulation are well under a hundred characters. Capping keeps an absurd
 * match out of the stored `extracted` blob and off the page that renders it.
 */
const MAX_DOI_LENGTH = 200;

/**
 * Strip the punctuation a DOI picks up from the prose around it.
 *
 * Closing brackets are the subtle case: `10.1002/(SICI)1097-0258(...)` ends in
 * a legitimate `)`, so a blanket strip would corrupt it. Only *unbalanced*
 * closers are removed, which handles the common `(see 10.1016/j.x.2020.01.001)`
 * without touching the SICI form.
 */
export function cleanDoi(raw: string): string | null {
  let doi = raw.trim().toLowerCase();
  // Sentence punctuation that can never end a DOI.
  doi = doi.replace(/[.,;:]+$/, '');
  for (;;) {
    const last = doi.at(-1);
    if (last !== ')' && last !== ']' && last !== '>') break;
    const open = last === ')' ? '(' : last === ']' ? '[' : '<';
    const opens = doi.split(open).length - 1;
    const closes = doi.split(last).length - 1;
    if (closes <= opens) break;
    doi = doi.slice(0, -1).replace(/[.,;:]+$/, '');
  }
  if (doi.length > MAX_DOI_LENGTH) return null;
  return /^10\.\d{4,9}\/.+/.test(doi) ? doi : null;
}

/**
 * Identifiers a filename gives away.
 *
 * Three conventions cover most of what lands in a download folder:
 *   - the DOI, with `/` replaced by `_` or `-` because a slash cannot appear
 *     in a filename (`10.1016_j.jpba.2020.113456.pdf`);
 *   - a PubMed or PMC accession (`PMC7123456.pdf`, `pmid_32155444.pdf`);
 *   - a reference manager's pattern (`Smith et al. - 2020 - Title of paper.pdf`),
 *     which yields a usable title and year even when no identifier survives.
 *
 * A title read from a filename is the weakest signal this module produces and
 * is treated accordingly: it can never reach `exact` confidence on its own.
 */
export function extractFromFilename(filename: string): ExtractedIdentifiers {
  const out = emptyExtraction();
  const base = filename.replace(/\.pdf$/i, '').trim();
  if (!base) return out;

  // Undo the slash substitutions a filesystem forces on a DOI before matching,
  // but only for the separator right after the registrant code — replacing
  // every underscore would corrupt suffixes that legitimately contain one.
  const deSlashed = base.replace(/\b(10\.\d{4,9})[_-](?=[a-z0-9])/gi, '$1/');
  const doiMatch = deSlashed.match(DOI_PATTERN);
  if (doiMatch?.[0]) {
    const doi = cleanDoi(doiMatch[0]);
    if (doi) {
      out.doi = doi;
      out.sources.doi = 'filename';
    }
  }

  const pmcid = firstCapture(base, PMCID_PATTERN);
  if (pmcid) {
    out.pmcid = `PMC${pmcid}`;
    out.sources.pmcid = 'filename';
  }
  const pmid =
    firstCapture(base, PMID_PATTERN) ??
    // `32155444.pdf` — a bare accession is only credible as a whole filename,
    // where nothing else could plausibly have produced it.
    (/^\d{7,8}$/.test(base) ? base : null);
  if (pmid) {
    out.pmid = pmid.replace(/^0+(?=\d)/, '');
    out.sources.pmid = 'filename';
  }

  // Reference-manager pattern: "Author et al. - 2020 - Title".
  const managerForm = base.match(/^(.+?)\s+-\s+((?:19|20)\d\d)\s+-\s+(.+)$/);
  if (managerForm?.[2] && managerForm[3]) {
    out.year = Number(managerForm[2]);
    out.sources.year = 'filename';
    const title = tidyTitle(managerForm[3]);
    if (title) {
      out.title = title;
      out.sources.title = 'filename';
    }
    return out;
  }

  const year = base.match(/\b(19|20)\d\d\b/);
  if (year?.[0]) {
    out.year = Number(year[0]);
    out.sources.year = 'filename';
  }
  // Only treat the filename as a title when it reads like one. A DOI-derived
  // or accession-derived name is an identifier the matcher already has, and
  // offering it as a title would produce nonsense fuzzy matches.
  if (!out.doi && !out.pmid && !out.pmcid) {
    const title = tidyTitle(base.replace(/\b(19|20)\d\d\b/, ' '));
    if (title && /\s/.test(title)) {
      out.title = title;
      out.sources.title = 'filename';
    }
  }
  return out;
}

/**
 * Identifiers the PDF itself carries.
 *
 * Three passes, cheapest first, each allowed to fill in what the previous one
 * left blank:
 *   1. the raw bytes — XMP packets are stored uncompressed far more often than
 *      not, and the Info dictionary usually is too;
 *   2. the Info dictionary specifically, for `/Title` and `/doi`;
 *   3. inflating `/FlateDecode` content streams and reading the show-text
 *      operators, which is where the page-one DOI stamp and the PMC footer
 *      live.
 *
 * Pass 3 is the expensive one and is skipped entirely once 1 and 2 have
 * produced an identifier strong enough to match on.
 */
export function extractFromPdfBytes(bytes: Uint8Array): ExtractedIdentifiers {
  const out = emptyExtraction();
  const head = Buffer.from(
    bytes.subarray(0, Math.min(bytes.byteLength, MAX_SCAN_BYTES)),
  );
  const raw = head.toString('latin1');

  readXmp(raw, out);
  readInfoDictionary(raw, out);

  // The page text comes first now, and the loose bytes only fill what it left
  // — because a hit in the uncompressed remainder cannot say which object it
  // came from, and one of the things living there is the reference list's link
  // annotations. Those are *other papers'* DOIs, and taking one as this
  // document's own would auto-attach the file to the paper it cites.
  if (!out.doi || !out.pmid || !out.pmcid) {
    const text = readFlateText(head);
    if (text) harvestFromText(dropReferenceSection(text), out, 'text');
  }
  if (!out.doi || !out.pmid || !out.pmcid) {
    harvestFromText(withoutLinkAnnotations(raw), out, 'raw');
  }
  return out;
}

/**
 * The file's own claims, with the filename filling the gaps.
 *
 * Document evidence wins every field it can supply: the publisher wrote it
 * into the artifact, whereas a filename survives renaming, truncation and
 * whatever the browser did to it on download. The filename is never
 * *contradicted* away, though — it is simply the lower-precedence source, and
 * where both agree the match is that much safer.
 */
export function extractPdfIdentifiers(
  bytes: Uint8Array,
  filename: string,
): ExtractedIdentifiers {
  let fromDocument: ExtractedIdentifiers;
  try {
    fromDocument = extractFromPdfBytes(bytes);
  } catch {
    // A malformed or exotic PDF must not fail the upload — the item still
    // belongs in the inbox, just without the accelerator.
    fromDocument = emptyExtraction();
  }
  const fromName = extractFromFilename(filename);

  const merged = emptyExtraction();
  for (const field of ['doi', 'pmid', 'pmcid', 'title', 'year'] as const) {
    const documentValue = fromDocument[field];
    if (documentValue !== null && documentValue !== undefined) {
      assign(merged, field, documentValue);
      merged.sources[field] = fromDocument.sources[field];
      continue;
    }
    const nameValue = fromName[field];
    if (nameValue !== null && nameValue !== undefined) {
      assign(merged, field, nameValue);
      merged.sources[field] = fromName.sources[field];
    }
  }
  return merged;
}

// ─── internals ─────────────────────────────────────────────────────────────

function emptyExtraction(): ExtractedIdentifiers {
  return { doi: null, pmid: null, pmcid: null, title: null, year: null, sources: {} };
}

function assign(
  target: ExtractedIdentifiers,
  field: 'doi' | 'pmid' | 'pmcid' | 'title' | 'year',
  value: string | number,
): void {
  if (field === 'year') target.year = Number(value);
  else target[field] = String(value);
}

function firstCapture(text: string, pattern: RegExp): string | null {
  // Every pattern here is /g, which carries mutable `lastIndex` — reset it so
  // a module-level regex cannot leak state between two files.
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  pattern.lastIndex = 0;
  return match?.[1] ?? null;
}

/**
 * Normalise a human-readable title: collapse whitespace, drop the separators
 * and leftovers a filename accumulates, and refuse anything too short or too
 * long to be a real article title.
 */
function tidyTitle(raw: string): string | null {
  const title = raw
    .replace(/[_]+/g, ' ')
    .replace(/\s*[-–—]\s*$/, '')
    .replace(/^\s*[-–—]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (title.length < 8 || title.length > 400) return null;
  // A string of digits and separators is an accession, not a title.
  if (!/[a-z]{3}/i.test(title)) return null;
  return title;
}

/**
 * The XMP packet — RDF/XML the publisher embeds, and the single most reliable
 * source in the file when it is present. Read from the raw bytes because XMP
 * is required by the spec to be stored uncompressed precisely so that tools
 * which do not parse PDF can find it.
 */
function readXmp(raw: string, out: ExtractedIdentifiers): void {
  const start = raw.indexOf('<x:xmpmeta');
  if (start === -1) return;
  const end = raw.indexOf('</x:xmpmeta>', start);
  const packet = raw.slice(start, end === -1 ? start + 200_000 : end);

  const doiTag = packet.match(
    /<(?:prism|bx|pdfx|dcterms):doi[^>]*>([^<]+)</i,
  );
  const doiIdentifier = packet.match(
    /<dc:identifier[^>]*>\s*(?:doi:)?\s*(10\.[^<\s]+)\s*</i,
  );
  const doi = cleanDoi(doiTag?.[1] ?? doiIdentifier?.[1] ?? '');
  if (doi && !out.doi) {
    out.doi = doi;
    out.sources.doi = 'xmp';
  }

  // dc:title is an RDF alternative-language container; take the first entry.
  const title = packet.match(
    /<dc:title[^>]*>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i,
  );
  const tidied = tidyTitle(decodeXmlEntities(title?.[1] ?? ''));
  if (tidied && !out.title) {
    out.title = tidied;
    out.sources.title = 'xmp';
  }

  const date = packet.match(
    /<(?:prism:coverDate|prism:publicationDate|dc:date)[^>]*>[\s\S]{0,80}?((?:19|20)\d\d)/i,
  );
  if (date?.[1] && out.year === null) {
    out.year = Number(date[1]);
    out.sources.year = 'xmp';
  }
}

/** `/Title`, `/Subject` and `/Keywords` from the document Info dictionary. */
function readInfoDictionary(raw: string, out: ExtractedIdentifiers): void {
  if (!out.title) {
    const literal = raw.match(/\/Title\s*\(((?:\\.|[^\\)])*)\)/);
    const hex = raw.match(/\/Title\s*<([0-9A-Fa-f\s]+)>/);
    const value =
      literal?.[1] !== undefined
        ? decodePdfLiteral(literal[1])
        : hex?.[1] !== undefined
          ? decodePdfHexString(hex[1])
          : '';
    const title = tidyTitle(value);
    if (title) {
      out.title = title;
      out.sources.title = 'info';
    }
  }
  if (!out.doi) {
    // Several producers write the DOI into /Subject or a custom /doi key.
    const subject = raw.match(
      /\/(?:Subject|WPS-ARTICLEDOI|doi)\s*\(((?:\\.|[^\\)])*)\)/i,
    );
    if (subject?.[1] !== undefined) {
      const found = decodePdfLiteral(subject[1]).match(DOI_PATTERN);
      DOI_PATTERN.lastIndex = 0;
      const doi = found?.[0] ? cleanDoi(found[0]) : null;
      if (doi) {
        out.doi = doi;
        out.sources.doi = 'info';
      }
    }
  }
}

/**
 * Blank out `/URI (…)` annotation values.
 *
 * A reference list hyperlinks every paper it cites, and those annotations are
 * routinely stored uncompressed — so they are the single likeliest thing a
 * raw-byte DOI scan will hit in a document whose own DOI the publisher did not
 * write into the metadata. Removing them takes the commonest wrong answer out
 * of the search space rather than relying on the downgrade alone.
 */
function withoutLinkAnnotations(raw: string): string {
  return raw.replace(/\/URI\s*\((?:\\.|[^\\)])*\)/g, ' ');
}

/**
 * Cut the extracted page text at the reference section.
 *
 * Everything after that heading is a list of *other* papers, each with its own
 * DOI, and the first one of those would be picked up exactly as if it were the
 * document's own. The stream budget makes reaching the bibliography unlikely
 * for a full-length article, but a letter, a case report or a short
 * communication — the shape a lot of toxicology literature takes — fits
 * comfortably inside it.
 *
 * Both languages this database is written in, plus the forms a heading is
 * typeset in (the text arrives without reliable spacing, so the match is
 * deliberately loose and anchored to the start of a recovered line).
 */
function dropReferenceSection(text: string): string {
  const heading =
    /^\s*\d*\.?\s*(references|reference list|bibliography|works cited|literature cited|litteratur|litteraturliste|referanser|kilder)\b/im;
  const match = heading.exec(text);
  return match ? text.slice(0, match.index) : text;
}

/** Pull every identifier a blob of text gives up, without overwriting stronger evidence. */
function harvestFromText(
  text: string,
  out: ExtractedIdentifiers,
  source: IdentifierSource,
): void {
  if (!out.doi) {
    DOI_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(DOI_PATTERN)) {
      const doi = cleanDoi(match[0] ?? '');
      // The first hit wins. What keeps that honest is what the caller passed
      // in: the page-text pass is cut at the reference section
      // (`dropReferenceSection`) and bounded to the first streams, and the
      // loose-bytes pass has its link annotations blanked and is graded as
      // `raw`, which cannot settle an identity by itself.
      if (doi) {
        out.doi = doi;
        out.sources.doi = source;
        break;
      }
    }
  }
  if (!out.pmid) {
    const pmid = firstCapture(text, PMID_PATTERN);
    if (pmid) {
      out.pmid = pmid.replace(/^0+(?=\d)/, '');
      out.sources.pmid = source;
    }
  }
  if (!out.pmcid) {
    const pmcid = firstCapture(text, PMCID_PATTERN);
    if (pmcid) {
      out.pmcid = `PMC${pmcid}`;
      out.sources.pmcid = source;
    }
  }
}

/**
 * Inflate the document's `/FlateDecode` streams and return the text the
 * show-text operators draw.
 *
 * Streams are visited in file order and the budget is small on purpose: page
 * one is what carries the article's own DOI, while the reference list — full
 * of *other* papers' DOIs — comes later. Reading the whole document would
 * reliably find a DOI and unreliably find the right one.
 */
function readFlateText(head: Buffer): string | null {
  const raw = head.toString('latin1');
  const pieces: string[] = [];
  let inflatedTotal = 0;
  let streams = 0;
  let cursor = 0;

  while (streams < MAX_STREAMS && inflatedTotal < MAX_TOTAL_INFLATED_BYTES) {
    const keyword = raw.indexOf('stream', cursor);
    if (keyword === -1) break;
    // The dictionary immediately preceding this keyword says how it is
    // encoded. Look back a bounded distance rather than parsing the object.
    const dictionary = raw.slice(Math.max(0, keyword - 600), keyword);
    cursor = keyword + 6;
    if (!dictionary.includes('/FlateDecode')) continue;
    // An image is Flate-encoded too and holds no text; inflating a full-page
    // scan wastes the entire budget on pixels.
    if (/\/Subtype\s*\/Image/.test(dictionary)) continue;

    // "stream" is followed by CRLF or LF, never by CR alone (PDF 32000 7.3.8).
    let start = cursor;
    if (raw[start] === '\r') start += 1;
    if (raw[start] === '\n') start += 1;
    const end = raw.indexOf('endstream', start);
    if (end === -1) break;
    cursor = end + 9;

    streams += 1;
    try {
      const inflated = inflateSync(head.subarray(start, end), {
        maxOutputLength: Math.min(
          MAX_INFLATED_BYTES,
          MAX_TOTAL_INFLATED_BYTES - inflatedTotal,
        ),
      });
      inflatedTotal += inflated.byteLength;
      pieces.push(readShowTextOperators(inflated.toString('latin1')));
    } catch {
      // Truncated, encrypted, or not actually Flate — the next stream may
      // still be readable, so this one is simply skipped.
      continue;
    }
  }
  return pieces.length > 0 ? pieces.join('\n') : null;
}

/**
 * Recover the drawn text from a content stream.
 *
 * A PDF does not store sentences; it stores show-text operators, and kerning
 * routinely splits a single word across the operands of ONE of them — a DOI
 * typically arrives as `[(10.1016/j.jpba.2) -25 (020.113) -12 (456)] TJ`.
 * So the operands of a single operator are concatenated with nothing between
 * them, which is the only way that string comes back whole.
 *
 * Between two operators the opposite is true, and getting this boundary wrong
 * is not cosmetic: the running head's DOI and the footer's "PMCID:" are
 * separate operators, and gluing them produces `…113456pmcid` — a DOI-shaped
 * string that is not the DOI, which is worse than finding nothing because it
 * looks like an answer. Hence a newline at every operator boundary.
 *
 * Word boundaries *within* a line are still lost, which costs nothing here:
 * identifiers contain no spaces, and titles come from metadata rather than
 * from this.
 */
function readShowTextOperators(stream: string): string {
  const lines: string[] = [];
  let current = '';
  // Strings first so an operator token cannot be matched inside one; the
  // third alternative is the show-text operators themselves (PDF 32000 9.4.3).
  // Nested unescaped parentheses inside a literal are legal but vanishingly
  // rare in a text operand; one yields a short fragment rather than a wrong
  // identifier, so it is not worth a parser.
  const pattern = /\(((?:\\.|[^\\()])*)\)|<([0-9A-Fa-f\s]+)>|(TJ|Tj|'|")/g;
  let match = pattern.exec(stream);
  while (match !== null) {
    if (match[3] !== undefined) {
      lines.push(current);
      current = '';
    } else if (match[1] !== undefined) {
      current += decodePdfLiteral(match[1]);
    } else {
      current += decodePdfHexString(match[2] ?? '');
    }
    match = pattern.exec(stream);
  }
  lines.push(current);
  return lines.join('\n');
}

/** PDF literal-string escapes (PDF 32000 7.3.4.2). */
function decodePdfLiteral(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = body[i + 1] ?? '';
    i += 1;
    switch (next) {
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case '\n': break; // line continuation
      case '\r':
        if (body[i + 1] === '\n') i += 1;
        break;
      default:
        if (next !== '' && next >= '0' && next <= '7') {
          let octal = next;
          let peek = body[i + 1] ?? '';
          while (octal.length < 3 && peek !== '' && peek >= '0' && peek <= '7') {
            octal += peek;
            i += 1;
            peek = body[i + 1] ?? '';
          }
          out += String.fromCharCode(parseInt(octal, 8));
        } else {
          out += next;
        }
    }
  }
  return out;
}

/**
 * Hex strings, which arrive in two flavours: plain bytes, and UTF-16BE behind
 * a byte-order mark (how `/Title` is written whenever it contains anything
 * outside ASCII, which for article titles is most of the time).
 */
function decodePdfHexString(body: string): string {
  const hex = body.replace(/\s+/g, '');
  const even = hex.length % 2 === 0 ? hex : `${hex}0`;
  const bytes = Buffer.from(even, 'hex');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16 *big*-endian, and Node decodes only little-endian — swap each
    // pair rather than reading every character as its byte-reversed twin.
    const paired = bytes.byteLength - 2;
    const body = Buffer.from(
      bytes.subarray(2, 2 + paired - (paired % 2)),
    );
    body.swap16();
    return body.toString('utf16le');
  }
  return bytes.toString('latin1');
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&amp;/g, '&');
}
