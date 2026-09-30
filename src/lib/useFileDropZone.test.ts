import { describe, expect, it } from 'vitest';
import { isDefinitelyNotPdf } from './useFileDropZone';

function file(name: string, type: string): File {
  return new File(['x'], name, { type });
}

describe('isDefinitelyNotPdf', () => {
  it('accepts a plain PDF', () => {
    expect(isDefinitelyNotPdf(file('paper.pdf', 'application/pdf'))).toBe(false);
    expect(isDefinitelyNotPdf(file('paper.pdf', 'application/x-pdf'))).toBe(
      false,
    );
  });

  it('rejects a file whose type says it is something else', () => {
    expect(isDefinitelyNotPdf(file('notes.docx', 'application/msword'))).toBe(
      true,
    );
    expect(isDefinitelyNotPdf(file('scan.png', 'image/png'))).toBe(true);
  });

  it('lets ambiguous downloads through to the server check', () => {
    // A browser download served without a useful content type, saved with no
    // extension, is a perfectly ordinary valid PDF — the magic-byte check on
    // the server decides, not this guard.
    expect(isDefinitelyNotPdf(file('download', ''))).toBe(false);
    expect(isDefinitelyNotPdf(file('paper', 'application/octet-stream'))).toBe(
      false,
    );
    expect(isDefinitelyNotPdf(file('paper.pdf', 'application/octet-stream'))).toBe(
      false,
    );
    // Dragged files often arrive with an empty type; the .pdf name is enough.
    expect(isDefinitelyNotPdf(file('paper.pdf', ''))).toBe(false);
  });

  it('still rejects a typeless file with a non-PDF extension', () => {
    expect(isDefinitelyNotPdf(file('notes.docx', ''))).toBe(true);
    expect(isDefinitelyNotPdf(file('data.csv', 'application/octet-stream'))).toBe(
      true,
    );
  });
});
