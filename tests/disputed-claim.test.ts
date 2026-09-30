import { describe, expect, it } from 'vitest';
import {
  claimAppearsIn,
  claimTextBlocks,
  collectTextBlocks,
  normalizeClaimText,
  rationaleWithDisputedClaim,
} from '../src/lib/disputedClaim';

describe('disputed-claim quote check (#1357)', () => {
  const row = {
    id: 7,
    editType: 'parameter',
    proposedValue: { value: 8.17, unit: null },
    agentNotes:
      'Kilden oppgir pKa1 = 8,17 (basisk amin) og pKa2 = 9,54. Bare den basiske\n  verdien legges i skalarfeltet.',
    submittedAt: new Date('2026-09-22T10:00:00Z'),
  };

  it('finds a verbatim quote regardless of case and whitespace', () => {
    expect(
      claimAppearsIn('pka1 = 8,17 (basisk amin)', collectTextBlocks(row)),
    ).toBe(true);
    expect(
      claimAppearsIn('Bare den basiske verdien legges', collectTextBlocks(row)),
    ).toBe(true);
  });

  it('refuses a claim the target never makes', () => {
    expect(
      claimAppearsIn('8,17 er stoffets eneste pKa', collectTextBlocks(row)),
    ).toBe(false);
  });

  it('reads numbers inside jsonb but skips timestamps', () => {
    const blocks = collectTextBlocks(row);
    expect(blocks).toContain('8.17');
    expect(blocks.some((b) => b.includes('2026'))).toBe(false);
  });

  it('makes a short structured value quotable with its field name', () => {
    const revision = { id: 3, parameter: 'pKa', newValue: 8.17 };
    const blocks = collectTextBlocks(revision);
    expect(claimAppearsIn('newValue: 8.17', blocks)).toBe(true);
    expect(claimAppearsIn('parameter: pKa', blocks)).toBe(true);
    // The label must be the real one.
    expect(claimAppearsIn('oldValue: 8.17', blocks)).toBe(false);
  });

  it('matches a sentence split across rich-text marks', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Basisk pKa er ' },
            { type: 'text', text: '8,17', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' ved 25 °C.' },
          ],
        },
      ],
    };
    const blocks = collectTextBlocks({ content: doc });
    expect(claimAppearsIn('Basisk pKa er 8,17 ved 25 °C', blocks)).toBe(true);
    // Node structure is not a claim.
    expect(claimAppearsIn('type: paragraph', blocks)).toBe(false);
    expect(claimAppearsIn('type: bold', blocks)).toBe(false);
    // Each fragment alone is below the minimum; only the rendered text works.
    expect(claimAppearsIn('pKa er 8,17 ved', collectTextBlocks({ a: 'pKa er ', b: '8,17 ved' }))).toBe(false);
  });

  it('does not let a quote straddle two fields', () => {
    expect(
      claimAppearsIn('parameter 8.17', collectTextBlocks(row)),
    ).toBe(false);
  });

  it('folds typographic quotes and dashes', () => {
    expect(normalizeClaimText('“20–100 timer”')).toBe('"20-100 timer"');
  });

  it('stores the claim under a Norwegian heading', () => {
    const stored = rationaleWithDisputedClaim(
      'Halveringstiden er 20–100 timer',
      'Kilden oppgir 20–50 timer.',
    );
    expect(stored.startsWith('**Bestridt påstand:**\n> Halveringstiden')).toBe(true);
    expect(stored).not.toMatch(/Disputed claim/);
  });

  it('ignores row metadata; only claim-bearing fields are quotable', () => {
    const pending = {
      id: 42,
      editType: 'param_entry',
      status: 'pending',
      submittedBy: 7,
      parameter: 'volumeOfDistribution',
      proposedValue: {
        op: 'create',
        input: {
          value: 0.35,
          quote: 'steady-state volume of distribution of approximately 350 mL/kg',
        },
      },
    };
    const blocks = claimTextBlocks('pending_edit', pending);
    expect(claimAppearsIn('status: pending', blocks)).toBe(false);
    expect(claimAppearsIn('editType: param_entry', blocks)).toBe(false);
    expect(claimAppearsIn('volume of distribution of approximately 350', blocks)).toBe(true);
    // A labelled payload value is proposal content and stays quotable.
    expect(claimAppearsIn('value: 0.35', blocks)).toBe(true);
  });

  it('ignores server-managed proposedMeta markers', () => {
    const pending = {
      parameter: 'volumeOfDistribution',
      proposedMeta: {
        sourceQuote: 'steady-state volume of distribution of approximately 350 mL/kg',
        revisedAt: '2026-09-22T10:00:00.000Z',
        conflict: { reason: 'direct_admin_write', id: 'abc', at: '2026-09-22T11:00:00Z' },
      },
    };
    const blocks = claimTextBlocks('pending_edit', pending);
    expect(claimAppearsIn('revisedAt: 2026-09-22', blocks)).toBe(false);
    expect(claimAppearsIn('reason: direct_admin_write', blocks)).toBe(false);
    expect(claimAppearsIn('direct_admin_write', blocks)).toBe(false);
    expect(claimAppearsIn('approximately 350 mL/kg', blocks)).toBe(true);
  });

  it('lists claim fields for learning-unit revisions', () => {
    const blocks = claimTextBlocks('learning_unit_revision', {
      id: 1,
      unitId: 4,
      editSummary: 'Retter clearance-formelen i eksempel 2.',
      content: { sourceCard: 'Clearance er dose delt på AUC.' },
    });
    expect(claimAppearsIn('Clearance er dose delt på AUC', blocks)).toBe(true);
    expect(claimAppearsIn('unitId: 4', blocks)).toBe(false);
  });

  it('treats leaf rich-text nodes as structure, not claims', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Halveringstiden er 20–100 timer.' }] },
        { type: 'horizontalRule' },
        { type: 'image', attrs: { src: 'https://example.org/figur.png', alt: 'figur' } },
      ],
    };
    const blocks = collectTextBlocks({ content: doc });
    expect(claimAppearsIn('type: horizontalRule', blocks)).toBe(false);
    // A field holding a bare list of nodes, not wrapped in a doc: each leaf is
    // reached by the generic recursion rather than through its parent.
    const bare = collectTextBlocks({ body: doc.content });
    expect(claimAppearsIn('type: horizontalRule', bare)).toBe(false);
    expect(claimAppearsIn('src: https://example.org/figur.png', bare)).toBe(false);
    expect(claimAppearsIn('https://example.org/figur.png', blocks)).toBe(false);
    expect(claimAppearsIn('Halveringstiden er 20–100 timer', blocks)).toBe(true);
    // A structured payload that merely has a `type` field keeps its labels.
    expect(
      claimAppearsIn('unit: mg/L', collectTextBlocks({ value: { type: 'range', unit: 'mg/L' } })),
    ).toBe(true);
  });

  it('renders a hard break as whitespace', () => {
    const para = {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Basisk pKa' },
        { type: 'hardBreak' },
        { type: 'text', text: 'er 8,17.' },
      ],
    };
    const blocks = collectTextBlocks({ content: para });
    expect(claimAppearsIn('Basisk pKa\ner 8,17', blocks)).toBe(true);
  });

  it('only allowlisted proposedMeta keys are quotable', () => {
    const blocks = claimTextBlocks('pending_edit', {
      proposedMeta: {
        editSummary: 'Legger til halveringstid fra preparatomtalen.',
        idempotencyKey: '3f6c1b2e-9a4d-4c1e-8b7a-2d5f6e7a8b9c',
        unverifiedSourceKeys: ['pmid:12345678-unverified'],
        source: 'conversation-ingestion',
      },
    });
    expect(claimAppearsIn('halveringstid fra preparatomtalen', blocks)).toBe(true);
    expect(claimAppearsIn('3f6c1b2e-9a4d-4c1e-8b7a', blocks)).toBe(false);
    expect(claimAppearsIn('pmid:12345678-unverified', blocks)).toBe(false);
    expect(claimAppearsIn('source: conversation-ingestion', blocks)).toBe(false);
  });

  it('does not offer structural ids in proposedValue as claims', () => {
    const factId = '7b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
    const removal = claimTextBlocks('pending_edit', {
      proposedValue: { removed: true, factId },
    });
    expect(claimAppearsIn(`factId: ${factId}`, removal)).toBe(false);
    expect(claimAppearsIn(factId, removal)).toBe(false);
    const reorder = claimTextBlocks('pending_edit', {
      proposedValue: { position: 12, factId, sourceIds: [123456789012] },
    });
    expect(claimAppearsIn('position: 12', reorder)).toBe(true);
    expect(claimAppearsIn('sourceIds: 123456789012', reorder)).toBe(false);
  });
});
