/**
 * Reading a paper's identifiers out of the PDF itself.
 *
 * This is the accelerator the bulk drop-off is built on: it decides whether a
 * folder of forty downloads links itself or waits for a human to identify
 * forty papers by eye. So the cases here are the shapes a real download
 * actually takes — a publisher's XMP packet, a DOI typeset across kerned show
 * operators, a PMC footer, and the filename conventions a library proxy or a
 * reference manager leaves behind.
 *
 * The failure it must never have is subtler than "found nothing": finding a
 * DOI-*shaped* string that is not the DOI looks like an answer and would link
 * the wrong paper. Two cases below exist only for that.
 */
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  cleanDoi,
  extractFromFilename,
  extractFromPdfBytes,
  extractPdfIdentifiers,
} from '../../api/_lib/pdf-identifiers.js';

/** Build a minimal but structurally real PDF: an XMP packet plus Flate streams. */
function buildPdf(options: {
  xmp?: string;
  contentStreams?: string[];
  info?: string;
  /** Uncompressed objects, e.g. the link annotations behind a reference list. */
  rawObjects?: string;
}): Uint8Array {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n', 'latin1')];
  if (options.rawObjects) {
    parts.push(Buffer.from(options.rawObjects, 'latin1'));
  }
  if (options.info) {
    parts.push(Buffer.from(`1 0 obj\n<<${options.info}>>\nendobj\n`, 'latin1'));
  }
  if (options.xmp) {
    parts.push(
      Buffer.from(
        `2 0 obj\n<</Type/Metadata/Subtype/XML/Length ${options.xmp.length}>>\nstream\n${options.xmp}\nendstream\nendobj\n`,
        'latin1',
      ),
    );
  }
  for (const content of options.contentStreams ?? []) {
    const deflated = deflateSync(Buffer.from(content, 'latin1'));
    parts.push(
      Buffer.from(
        `3 0 obj\n<</Length ${deflated.length}/Filter/FlateDecode>>\nstream\n`,
        'latin1',
      ),
      deflated,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    );
  }
  parts.push(Buffer.from('%%EOF\n', 'latin1'));
  return Buffer.concat(parts);
}

const XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description>
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Population pharmacokinetics of midazolam in critically ill adults</rdf:li></rdf:Alt></dc:title>
<prism:doi>10.1016/j.jpba.2020.113456</prism:doi>
<prism:coverDate>2020-05-30</prism:coverDate>
</rdf:Description></rdf:RDF></x:xmpmeta>`;

describe('cleanDoi', () => {
  it('strips the sentence punctuation a DOI picks up from prose', () => {
    expect(cleanDoi('10.1016/j.jpba.2020.113456.')).toBe(
      '10.1016/j.jpba.2020.113456',
    );
    expect(cleanDoi('10.1016/j.jpba.2020.113456,')).toBe(
      '10.1016/j.jpba.2020.113456',
    );
  });

  it('drops only UNBALANCED closing brackets', () => {
    // "(see 10.xxxx/yyy)" — the paren belongs to the sentence.
    expect(cleanDoi('10.1234/abc)')).toBe('10.1234/abc');
    // A SICI-style DOI legitimately ends in ')'; corrupting it would make the
    // handle unresolvable, which is worse than leaving a stray paren on.
    expect(cleanDoi('10.1002/(sici)1097-0258(1998)17:3<1::aid>2.0.co;2-q')).toBe(
      '10.1002/(sici)1097-0258(1998)17:3<1::aid>2.0.co;2-q',
    );
  });

  it('lower-cases, because DOIs are case-insensitive by spec', () => {
    expect(cleanDoi('10.1016/J.JPBA.2020.113456')).toBe(
      '10.1016/j.jpba.2020.113456',
    );
  });

  it('rejects anything that is not DOI-shaped', () => {
    expect(cleanDoi('not a doi')).toBeNull();
    expect(cleanDoi('10.1016')).toBeNull();
    expect(cleanDoi('')).toBeNull();
  });

  it('rejects an absurdly long match', () => {
    // The suffix pattern has to be permissive, so a run of matching bytes in a
    // malformed file can extend a "DOI" indefinitely. Real ones are short, and
    // an absurd one would be stored and then rendered.
    expect(cleanDoi(`10.1016/${'a'.repeat(500)}`)).toBeNull();
    expect(cleanDoi(`10.1016/${'a'.repeat(50)}`)).not.toBeNull();
  });
});

describe('extractFromFilename', () => {
  it('recovers a DOI whose slash the filesystem replaced', () => {
    const found = extractFromFilename('10.1016_j.jpba.2020.113456.pdf');
    expect(found.doi).toBe('10.1016/j.jpba.2020.113456');
    expect(found.sources.doi).toBe('filename');
  });

  it('reads a PMC accession', () => {
    expect(extractFromFilename('PMC7123456.pdf').pmcid).toBe('PMC7123456');
  });

  it('reads a labelled PMID, and a bare one only as the whole name', () => {
    expect(extractFromFilename('pmid_32155444.pdf').pmid).toBe('32155444');
    expect(extractFromFilename('32155444.pdf').pmid).toBe('32155444');
    // Eight digits inside a longer name is a page range, a date, an
    // accession — anything. Treating it as a PMID would invent a match.
    expect(extractFromFilename('scan 32155444 page 2.pdf').pmid).toBeNull();
  });

  it('reads a reference manager’s "Author - Year - Title" pattern', () => {
    const found = extractFromFilename(
      'Smith et al. - 2020 - Population pharmacokinetics of midazolam.pdf',
    );
    expect(found.year).toBe(2020);
    expect(found.title).toBe('Population pharmacokinetics of midazolam');
  });

  it('does not offer an identifier-derived filename as a title', () => {
    // The matcher already has the DOI; a "title" of "10.1016_j..." would only
    // produce nonsense trigram candidates if the DOI lookup missed.
    expect(extractFromFilename('10.1016_j.jpba.2020.113456.pdf').title).toBeNull();
    expect(extractFromFilename('PMC7123456.pdf').title).toBeNull();
  });

  it('ignores a name too short or too numeric to be a title', () => {
    expect(extractFromFilename('scan.pdf').title).toBeNull();
    expect(extractFromFilename('2020-05-30 14_22_01.pdf').title).toBeNull();
  });

  it('survives an empty or extension-only name', () => {
    expect(extractFromFilename('.pdf').doi).toBeNull();
    expect(extractFromFilename('').title).toBeNull();
  });
});

describe('extractFromPdfBytes', () => {
  it('reads the DOI, title and year out of an XMP packet', () => {
    const found = extractFromPdfBytes(buildPdf({ xmp: XMP }));
    expect(found.doi).toBe('10.1016/j.jpba.2020.113456');
    expect(found.sources.doi).toBe('xmp');
    expect(found.title).toBe(
      'Population pharmacokinetics of midazolam in critically ill adults',
    );
    expect(found.year).toBe(2020);
  });

  it('reassembles a DOI split across kerned show-text operands', () => {
    // How a typeset running head actually stores it: one TJ array, the string
    // broken wherever the kerning table said so.
    const pdf = buildPdf({
      contentStreams: [
        'BT [(https://doi.org/10.1016/j.jpba.2) -25 (020.113) -12 (456)] TJ ET',
      ],
    });
    expect(extractFromPdfBytes(pdf).doi).toBe('10.1016/j.jpba.2020.113456');
  });

  it('does not glue the next line onto the end of a DOI', () => {
    // The regression this guards: concatenating every operand in the stream
    // produced "10.1016/j.jpba.2020.113456pmcid" — DOI-shaped, resolvable to
    // nothing, and indistinguishable from a real answer to anything that only
    // checks the pattern.
    const pdf = buildPdf({
      contentStreams: [
        'BT (https://doi.org/10.1016/j.jpba.2020.113456) Tj ET\n' +
          'BT (PMCID: PMC7123456   PMID: 32155444) Tj ET',
      ],
    });
    const found = extractFromPdfBytes(pdf);
    expect(found.doi).toBe('10.1016/j.jpba.2020.113456');
    expect(found.pmcid).toBe('PMC7123456');
    expect(found.pmid).toBe('32155444');
  });

  it('reads a UTF-16BE hex /Title', () => {
    const utf16 = Buffer.from('﻿Effects of clearance on exposure', 'utf16le');
    utf16.swap16(); // the Info dictionary stores big-endian
    const pdf = buildPdf({ info: `/Title <${utf16.toString('hex')}>` });
    expect(extractFromPdfBytes(pdf).title).toBe(
      'Effects of clearance on exposure',
    );
  });

  it('decodes escapes in a literal /Title', () => {
    const pdf = buildPdf({
      info: String.raw`/Title (Midazolam \(a benzodiazepine\) in the ICU)`,
    });
    expect(extractFromPdfBytes(pdf).title).toBe(
      'Midazolam (a benzodiazepine) in the ICU',
    );
  });

  it('returns nothing for a PDF with no text layer, rather than guessing', () => {
    const found = extractFromPdfBytes(buildPdf({ contentStreams: ['q 1 0 0 1 0 0 cm Q'] }));
    expect(found.doi).toBeNull();
    expect(found.title).toBeNull();
  });

  it('skips a stream that claims Flate but is not', () => {
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.7\n', 'latin1'),
      Buffer.from('1 0 obj\n<</Length 9/Filter/FlateDecode>>\nstream\n', 'latin1'),
      Buffer.from('not flate', 'latin1'),
      Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
    ]);
    expect(() => extractFromPdfBytes(pdf)).not.toThrow();
  });
});

describe('extractPdfIdentifiers', () => {
  it('prefers what the document says over what the file is called', () => {
    // The download was renamed — plausibly for the paper it was fetched
    // beside. The artifact's own metadata is the stronger claim.
    const found = extractPdfIdentifiers(
      buildPdf({ xmp: XMP }),
      '10.9999_wrong.paper.pdf',
    );
    expect(found.doi).toBe('10.1016/j.jpba.2020.113456');
    expect(found.sources.doi).toBe('xmp');
  });

  it('falls back to the filename for whatever the document omits', () => {
    const found = extractPdfIdentifiers(
      buildPdf({ contentStreams: ['BT (no identifiers here) Tj ET'] }),
      '10.1016_j.jpba.2020.113456.pdf',
    );
    expect(found.doi).toBe('10.1016/j.jpba.2020.113456');
    expect(found.sources.doi).toBe('filename');
  });

  it('does not take a cited paper\u2019s DOI from a link annotation', () => {
    // A reference list hyperlinks every paper it cites, and those annotations
    // are routinely stored uncompressed. With no DOI of its own in the
    // metadata, a raw-byte scan would otherwise return the FIRST CITED
    // paper's DOI — and, marked as document evidence, that is enough to
    // auto-attach this file to a paper it merely references.
    const pdf = buildPdf({
      rawObjects:
        '4 0 obj\n<</Type/Annot/Subtype/Link/A<</URI (https://doi.org/10.9999/cited.paper.one)>>>>\nendobj\n',
      contentStreams: ['BT (An article with no DOI printed on it) Tj ET'],
    });
    expect(extractFromPdfBytes(pdf).doi).toBeNull();
  });

  it('marks a loose raw-byte DOI as `raw`, not as document text', () => {
    // Anything left in the uncompressed region cannot say which object it came
    // from, so it may propose a match but never settle one. The grading in
    // pdf-inbox-match.ts is what enforces that; this pins the label it reads.
    const pdf = buildPdf({
      rawObjects: '5 0 obj\n<</SomeKey (10.1016/j.jpba.2020.113456)>>\nendobj\n',
    });
    const found = extractFromPdfBytes(pdf);
    expect(found.doi).toBe('10.1016/j.jpba.2020.113456');
    expect(found.sources.doi).toBe('raw');
  });

  it('stops reading page text at the reference section', () => {
    // A letter or case report can fit its bibliography inside the stream
    // budget, and the first DOI after "References" belongs to another paper.
    const pdf = buildPdf({
      contentStreams: [
        'BT (A short communication with no DOI in its header) Tj ET\n' +
          'BT (References) Tj ET\n' +
          'BT (1. Smith J. Some other paper. https://doi.org/10.9999/cited.one) Tj ET',
      ],
    });
    expect(extractFromPdfBytes(pdf).doi).toBeNull();
  });

  it('still reads the document\u2019s own DOI printed ahead of the references', () => {
    // The cut must not cost the common case: page one's stamp comes first.
    const pdf = buildPdf({
      contentStreams: [
        'BT (https://doi.org/10.1016/j.jpba.2020.113456) Tj ET\n' +
          'BT (References) Tj ET\n' +
          'BT (1. Smith J. https://doi.org/10.9999/cited.one) Tj ET',
      ],
    });
    const found = extractFromPdfBytes(pdf);
    expect(found.doi).toBe('10.1016/j.jpba.2020.113456');
    expect(found.sources.doi).toBe('text');
  });

  it('never throws on a file that is not a readable PDF', () => {
    // An upload that reaches here has passed the %PDF- magic check, but that
    // guarantees nothing about the rest. Losing the bytes over a parse error
    // would be strictly worse than filing them unidentified.
    const garbage = Buffer.concat([
      Buffer.from('%PDF-1.7\n', 'latin1'),
      Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256)),
    ]);
    const found = extractPdfIdentifiers(garbage, 'mystery.pdf');
    expect(found.doi).toBeNull();
  });
});
