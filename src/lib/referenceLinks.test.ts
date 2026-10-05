import { describe, expect, it } from 'vitest';
import { parseReferences } from './referenceLinks';

function refs(text: string) {
  return parseReferences(text)
    .filter((s) => s.type === 'ref')
    .map((s) => (s.type === 'ref' ? [s.kind, s.id, s.text] : null));
}

describe('parseReferences', () => {
  it('finds the references in an agent edit summary', () => {
    const text =
      'Retter konkordansgrunnlag etter melding fra fagfelle (diskusjon #1379, se også bestridelse #871 på pending_edit 1412): fjerner påstand.';
    expect(refs(text)).toEqual([
      ['discussion', 1379, 'diskusjon #1379'],
      ['dispute', 871, 'bestridelse #871'],
      ['pending_edit', 1412, 'pending_edit 1412'],
    ]);
  });

  it('round-trips the text unchanged', () => {
    const text = 'see dispute #4 and discussion #9, then pending edit #2.';
    expect(
      parseReferences(text)
        .map((s) => s.text)
        .join(''),
    ).toBe(text);
  });

  it('recognises English, inflected and table-name forms', () => {
    expect(
      refs(
        'Dispute #12; innsigelsen #3; drug_discussion 44; endringsforslag #5',
      ),
    ).toEqual([
      ['dispute', 12, 'Dispute #12'],
      ['dispute', 3, 'innsigelsen #3'],
      ['discussion', 44, 'drug_discussion 44'],
      ['pending_edit', 5, 'endringsforslag #5'],
    ]);
  });

  it('leaves plain prose and citation numbers alone', () => {
    expect(refs('discussion 2 of the paper; Belegg: #3487; n=30')).toEqual([]);
    expect(parseReferences('plain')).toEqual([{ type: 'text', text: 'plain' }]);
  });
});
