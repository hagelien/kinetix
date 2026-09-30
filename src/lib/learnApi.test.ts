import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchLearningUnit, fetchLearningUnits } from './learnApi';

const originalFetch = global.fetch;

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('learnApi', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetches the unit list and unwraps `units`', async () => {
    const fn = mockFetch(200, {
      units: [
        {
          id: 1,
          slug: 'vd',
          title: 'Volume of distribution',
          difficulty: 'foundational',
          domains: ['pharmacokinetics'],
        },
      ],
    });
    const units = await fetchLearningUnits();
    expect(fn).toHaveBeenCalledWith('/api/learning-units');
    expect(units).toHaveLength(1);
    expect(units[0]!.slug).toBe('vd');
  });

  it('passes citationId as a query param', async () => {
    const fn = mockFetch(200, { units: [] });
    await fetchLearningUnits({ citationId: 10 });
    expect(fn).toHaveBeenCalledWith('/api/learning-units?citationId=10');
  });

  it('fetches a single unit with content + source', async () => {
    const detail = {
      id: 1,
      slug: 'vd',
      title: 'Volume of distribution',
      difficulty: 'foundational',
      domains: ['pharmacokinetics'],
      content: {
        sourceCard: {
          whyItMatters: 'matters',
          sourceStatus: ['foundational'],
          estimatedReadingMinutes: 20,
        },
        prerequisites: [],
        preReadingPrompts: ['a', 'b', 'c'],
        objectives: ['know vd'],
        questions: [],
      },
      source: {
        citationId: 10,
        type: 'doi',
        identifier: '10.1/x',
        url: 'https://doi.org/10.1/x',
        metadata: { title: 'Paper' },
      },
    };
    const fn = mockFetch(200, detail);
    const unit = await fetchLearningUnit(1);
    expect(fn).toHaveBeenCalledWith('/api/learning-units?id=1');
    expect(unit.title).toBe('Volume of distribution');
    expect(unit.source?.url).toBe('https://doi.org/10.1/x');
  });

  it('throws on a non-ok response', async () => {
    mockFetch(404, { error: 'Learning unit not found' });
    await expect(fetchLearningUnit(999)).rejects.toThrow(
      'Learning unit not found',
    );
  });
});
