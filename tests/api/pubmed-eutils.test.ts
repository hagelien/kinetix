import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSearchTerm,
  classifyIdentifier,
  fetchAbstracts,
  findRelated,
  resolveIdentifiers,
  jatsToText,
  parseMedline,
  resetPubMedThrottle,
  searchPubMed,
  toEntrezDate,
} from '../../api/_lib/pubmed-eutils.ts';
import { CITATION_FORMATTERS } from '../../api/_lib/mcp-pubmed-tools.ts';
import type { PubMedRecord } from '../../api/_lib/pubmed-eutils.ts';

describe('toEntrezDate', () => {
  it('accepts year, year-month and full dates', () => {
    expect(toEntrezDate('2021')).toBe('2021');
    expect(toEntrezDate('2021-03')).toBe('2021/03');
    expect(toEntrezDate('2021-03-09')).toBe('2021/03/09');
  });

  it('rejects anything else', () => {
    expect(toEntrezDate('March 2021')).toBeNull();
    expect(toEntrezDate('21-03-09')).toBeNull();
    expect(toEntrezDate('')).toBeNull();
  });

  it('rejects dates that match the shape but not the calendar', () => {
    // Entrez answers a [PDAT] clause containing one of these with zero hits
    // and no error — indistinguishable from a real absence of literature.
    expect(toEntrezDate('2024-13')).toBeNull();
    expect(toEntrezDate('2024-00')).toBeNull();
    expect(toEntrezDate('2023-02-31')).toBeNull();
    expect(toEntrezDate('2024-04-31')).toBeNull();
    expect(toEntrezDate('2024-01-00')).toBeNull();
    expect(toEntrezDate('2024-01-32')).toBeNull();
  });

  it('accepts real month lengths, including leap days', () => {
    expect(toEntrezDate('2024-02-29')).toBe('2024/02/29'); // leap year
    expect(toEntrezDate('2023-02-28')).toBe('2023/02/28');
    expect(toEntrezDate('2024-04-30')).toBe('2024/04/30');
    expect(toEntrezDate('2024-12-31')).toBe('2024/12/31');
  });

  it('rejects a leap day in a non-leap year', () => {
    expect(toEntrezDate('2023-02-29')).toBeNull();
  });
});

describe('buildSearchTerm', () => {
  it('passes a bare query through untouched', () => {
    expect(buildSearchTerm('trimipramine AND postmortem')).toBe(
      'trimipramine AND postmortem',
    );
  });

  it('ANDs an OR-group of publication types onto the query', () => {
    expect(buildSearchTerm('trimipramine', ['Journal Article', 'Review'])).toBe(
      '(trimipramine) AND ("Journal Article"[Publication Type] OR "Review"[Publication Type])',
    );
  });

  it('strips quotes from a type so the filter cannot be broken open', () => {
    expect(buildSearchTerm('x', ['Rev"iew'])).toBe(
      '(x) AND ("Review"[Publication Type])',
    );
  });

  it('embeds a date range so the echoed query is self-contained', () => {
    // Verified equivalent to mindate/maxdate against live Entrez: aspirin
    // 1000–1990 returns 18,022 either way.
    expect(buildSearchTerm('aspirin', [], { from: '2015', to: '2016' })).toBe(
      '(aspirin) AND ("2015"[PDAT] : "2016"[PDAT])',
    );
  });
});

describe('searchPubMed request parameters', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetPubMedThrottle();
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      // No hits, so the call stops after esearch and the assertions below see
      // exactly one URL.
      text: async () =>
        JSON.stringify({ esearchresult: { count: '0', idlist: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function paramsFor(input: Parameters<typeof searchPubMed>[0]) {
    await searchPubMed(input);
    return new URL(fetchMock.mock.calls[0]?.[0] as string).searchParams;
  }

  it('translates the journal sort to Entrez\'s JournalName', async () => {
    // esearch answers "Unknown sort schema 'journal' ignored" and returns
    // default-ordered results, so sending it verbatim fails silently.
    const params = await paramsFor({ query: 'aspirin', sort: 'journal' });
    expect(params.get('sort')).toBe('JournalName');
  });

  it('sends pub_date and author unchanged (Entrez accepts both)', async () => {
    expect((await paramsFor({ query: 'a', sort: 'pub_date' })).get('sort')).toBe(
      'pub_date',
    );
    resetPubMedThrottle();
    fetchMock.mockClear();
    expect((await paramsFor({ query: 'a', sort: 'author' })).get('sort')).toBe(
      'author',
    );
  });

  it('omits sort entirely for relevance, which is the default', async () => {
    const params = await paramsFor({ query: 'aspirin', sort: 'relevance' });
    expect(params.has('sort')).toBe(false);
  });

  it('supplies a lower bound when only date_to is given', async () => {
    // Entrez applies a date range only when both ends are present; given one
    // it ignores the filter and returns the unfiltered set, including records
    // newer than the requested cutoff.
    const params = await paramsFor({ query: 'aspirin', dateTo: '1990' });
    expect(params.get('term')).toBe(
      '(aspirin) AND ("1000"[PDAT] : "1990"[PDAT])',
    );
  });

  it('supplies an upper bound when only date_from is given', async () => {
    const params = await paramsFor({ query: 'aspirin', dateFrom: '2015-03' });
    expect(params.get('term')).toBe(
      '(aspirin) AND ("2015/03"[PDAT] : "3000"[PDAT])',
    );
  });

  it('carries dates in the query itself, not as separate parameters', async () => {
    // The echoed query is what agents are told to quote for reproducibility,
    // so every constraint except ordering has to live inside it.
    const params = await paramsFor({ query: 'aspirin', dateFrom: '2015' });
    expect(params.has('mindate')).toBe(false);
    expect(params.has('maxdate')).toBe(false);
    expect(params.has('datetype')).toBe(false);
  });

  it('combines publication types and dates in one term', async () => {
    const params = await paramsFor({
      query: 'trimipramine',
      articleTypes: ['Journal Article'],
      dateFrom: '2015',
      dateTo: '2020',
    });
    expect(params.get('term')).toBe(
      '(trimipramine) AND ("Journal Article"[Publication Type]) AND ' +
        '("2015"[PDAT] : "2020"[PDAT])',
    );
  });

  it('adds no date clause when neither bound is given', async () => {
    const params = await paramsFor({ query: 'aspirin' });
    expect(params.get('term')).toBe('aspirin');
    expect(params.has('datetype')).toBe(false);
  });

  it('surfaces unmatched terms and fields from errorlist', async () => {
    // phrasesnotfound lives under errorlist, not warninglist — reading it off
    // warninglist silently discarded every one of these.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          esearchresult: {
            count: '0',
            idlist: [],
            errorlist: {
              phrasesnotfound: ['zzqqxx', 'flurbleglop'],
              fieldsnotfound: ['NoSuchField'],
            },
            warninglist: {
              phrasesignored: [],
              quotedphrasesnotfound: [],
              outputmessages: ['No items found.'],
            },
          },
        }),
    });

    const result = await searchPubMed({ query: 'zzqqxx flurbleglop' });
    expect(result.warnings).toEqual([
      'Term not found in PubMed and dropped from the query: zzqqxx',
      'Term not found in PubMed and dropped from the query: flurbleglop',
      'Unknown search field, ignored: NoSuchField',
      'No items found.',
    ]);
  });

  it('warns when a quoted phrase silently stopped constraining the search', async () => {
    // The dangerous case: PubMed drops the phrase and returns a much larger
    // set, so the caller gets plausible results for a query they did not run.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          esearchresult: {
            count: '92418',
            idlist: [],
            errorlist: { phrasesnotfound: [], fieldsnotfound: [] },
            warninglist: {
              phrasesignored: [],
              quotedphrasesnotfound: ['"a phrase that does not exist anywhere"'],
              outputmessages: [],
            },
          },
        }),
    });

    const result = await searchPubMed({ query: 'aspirin OR "…"' });
    expect(result.total).toBe(92418);
    expect(result.warnings).toEqual([
      'Quoted phrase not found, so it did not constrain the search: ' +
        '"a phrase that does not exist anywhere"',
    ]);
  });

  it('reports no warnings for a clean search', async () => {
    const result = await searchPubMed({ query: 'aspirin' });
    expect(result.warnings).toEqual([]);
  });

  it('rejects an unparseable date before issuing a request', async () => {
    await expect(
      searchPubMed({ query: 'aspirin', dateFrom: 'March 2021' }),
    ).rejects.toThrow(/Invalid date_from/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a reversed date range instead of reporting no literature', async () => {
    // Live Entrez answers ("2024"[PDAT] : "2020"[PDAT]) with count 0, an empty
    // errorlist and no warnings — indistinguishable from a real absence.
    await expect(
      searchPubMed({ query: 'aspirin', dateFrom: '2024', dateTo: '2020' }),
    ).rejects.toThrow(/later than date_to/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a reversed range that only differs by month', async () => {
    await expect(
      searchPubMed({ query: 'aspirin', dateFrom: '2020-06', dateTo: '2020-03' }),
    ).rejects.toThrow(/later than date_to/);
  });

  it('accepts a same-year range whose bounds have different precision', async () => {
    // 2020 as a lower bound is 2020/01/01; as an upper bound, 2020/12/31.
    await expect(
      searchPubMed({ query: 'aspirin', dateFrom: '2020', dateTo: '2020' }),
    ).resolves.toBeDefined();
    await expect(
      searchPubMed({ query: 'aspirin', dateFrom: '2020-01-01', dateTo: '2020' }),
    ).resolves.toBeDefined();
  });
});

describe('resolveIdentifiers', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  function respond(payload: unknown) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    };
  }

  beforeEach(() => {
    resetPubMedThrottle();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('leaves a nonexistent PMID null so it lands in `unresolved`', async () => {
    fetchMock
      // ID converter: unknown to PMC.
      .mockResolvedValueOnce(
        respond({
          records: [
            {
              'requested-id': '999999999',
              status: 'error',
              errmsg: 'Identifier not found in PMC',
            },
          ],
        }),
      )
      // esummary fallback: unknown to PubMed either.
      .mockResolvedValueOnce(respond({ result: { uids: [] } }));

    const [resolved] = await resolveIdentifiers(['999999999']);
    expect(resolved?.pmid).toBeNull();
    expect(resolved?.pmcid).toBeNull();
    expect(resolved?.status).toBe('not found in PubMed');
  });

  it('keeps a real PMID and names its PMC record in the status', async () => {
    fetchMock
      .mockResolvedValueOnce(
        respond({
          records: [
            {
              'requested-id': '33442447',
              pmid: 33442447,
              pmcid: 'PMC7772728',
              doi: '10.4254/wjh.v12.i12.1182',
            },
          ],
        }),
      );

    const [resolved] = await resolveIdentifiers(['33442447']);
    expect(resolved?.pmid).toBe('33442447');
    expect(resolved?.pmcid).toBe('PMC7772728');
    // The converter answered in full, so no esummary fallback was needed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports the PMC record in the status when the converter gave no DOI', async () => {
    // status drives whether a client tries fetch_pmc_full_text, so it must
    // follow the PMCID rather than which lookup happened to answer.
    fetchMock
      .mockResolvedValueOnce(
        respond({
          records: [{ 'requested-id': '33442447', pmcid: 'PMC7772728' }],
        }),
      )
      .mockResolvedValueOnce(
        respond({
          result: {
            uids: ['33442447'],
            '33442447': {
              uid: '33442447',
              title: 'A study',
              articleids: [{ idtype: 'pmc', value: 'PMC7772728' }],
            },
          },
        }),
      );

    const [resolved] = await resolveIdentifiers(['33442447']);
    expect(resolved?.pmcid).toBe('PMC7772728');
    expect(resolved?.status).toContain('PMC record PMC7772728');
    expect(resolved?.status).not.toContain('no PMC record');
  });
});

describe('findRelated score parsing', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetPubMedThrottle();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function linkset(links: unknown[]) {
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          linksets: [{ linksetdbs: [{ linkname: 'pubmed_pubmed', links }] }],
        }),
    };
  }

  it('accepts both the number and numeric-string serialisations', async () => {
    // pubmed_pubmed returns numbers, but sibling link sets in the same
    // response return strings, so the shape is not guaranteed.
    fetchMock.mockResolvedValue(
      linkset([
        { id: '1', score: 32445784 },
        { id: '2', score: '34095777' },
      ]),
    );

    const related = await findRelated('33245133', 10);
    expect(related).toEqual([
      { pmid: '1', score: 32445784 },
      { pmid: '2', score: 34095777 },
    ]);
  });

  it('treats an empty or non-numeric score as absent, not as zero', async () => {
    // pubmed_pubmed_citedin really does return "score": "" for every entry.
    fetchMock.mockResolvedValue(
      linkset([
        { id: '1', score: '' },
        { id: '2', score: 'n/a' },
        { id: '3' },
      ]),
    );

    const related = await findRelated('33245133', 10);
    expect(related.map((r) => r.score)).toEqual([null, null, null]);
  });
});

describe('classifyIdentifier', () => {
  it('separates PMIDs, PMCIDs and DOIs', () => {
    // The PMC converter infers one idtype per call and 400s on a mixed list,
    // so this grouping is what keeps a mixed request working.
    expect(classifyIdentifier('33245133')).toBe('pmid');
    expect(classifyIdentifier('PMC7772728')).toBe('pmcid');
    expect(classifyIdentifier('pmc7772728')).toBe('pmcid');
    expect(classifyIdentifier('10.1093/jat/bkaa107')).toBe('doi');
    expect(classifyIdentifier(' 10.1093/jat/bkaa107 ')).toBe('doi');
  });
});

describe('parseMedline', () => {
  const sample = [
    'PMID- 33245133',
    'TI  - Postmortem drug redistribution: a compilation of postmortem/antemortem',
    '      drug concentration ratios.',
    'AB  - Postmortem redistribution complicates interpretation. A second sentence',
    '      continues the abstract.',
    'AU  - Mantinieks D',
    'AU  - Gerostamoulos D',
    'JT  - Journal of analytical toxicology',
    'TA  - J Anal Toxicol',
    'DP  - 2021 Jan 15',
    'PT  - Journal Article',
    'MH  - *Postmortem Changes',
    'PMC - PMC1234567',
    'CI  - (c) The Author(s) 2021.',
    'AID - 10.1093/jat/bkaa107 [doi]',
    '',
    'PMID- 11111111',
    'TI  - No abstract here.',
    'DP  - 1968',
    '',
  ].join('\n');

  it('splits records and joins continuation lines', () => {
    const records = parseMedline(sample);
    expect(records).toHaveLength(2);
    expect(records[0]?.TI?.[0]).toBe(
      'Postmortem drug redistribution: a compilation of postmortem/antemortem drug concentration ratios.',
    );
    expect(records[0]?.AB?.[0]).toContain('A second sentence continues');
  });

  it('keeps repeated tags as a list', () => {
    const records = parseMedline(sample);
    expect(records[0]?.AU).toEqual(['Mantinieks D', 'Gerostamoulos D']);
  });

  it('records the second entry with no AB tag', () => {
    const records = parseMedline(sample);
    expect(records[1]?.PMID?.[0]).toBe('11111111');
    expect(records[1]?.AB).toBeUndefined();
  });
});

describe('fetchAbstracts abstract selection', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  function medlineResponse(body: string) {
    return { ok: true, status: 200, text: async () => body };
  }

  beforeEach(() => {
    resetPubMedThrottle();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefers the indexed abstract and keeps the publisher one separate', async () => {
    // Concatenating AB and OAB reads as one continuous abstract with the
    // claims stated twice.
    fetchMock.mockResolvedValue(
      medlineResponse(
        ['PMID- 1', 'AB  - Indexed abstract.', 'OAB - Publisher abstract.', ''].join(
          '\n',
        ),
      ),
    );

    const [record] = await fetchAbstracts(['1']);
    expect(record?.abstract).toBe('Indexed abstract.');
    expect(record?.abstractSource).toBe('medline');
    expect(record?.otherAbstracts).toEqual(['Publisher abstract.']);
  });

  it('falls back to the publisher abstract when there is no indexed one', async () => {
    fetchMock.mockResolvedValue(
      medlineResponse(['PMID- 2', 'OAB - Publisher abstract.', ''].join('\n')),
    );

    const [record] = await fetchAbstracts(['2']);
    expect(record?.abstract).toBe('Publisher abstract.');
    expect(record?.abstractSource).toBe('publisher');
    expect(record?.otherAbstracts).toEqual([]);
  });

  it('keeps repeated publisher abstracts apart when there is no indexed one', async () => {
    // Alternate or translated versions, not sections of one abstract — a
    // structured abstract arrives as a single AB with continuation lines.
    fetchMock.mockResolvedValue(
      medlineResponse(
        [
          'PMID- 4',
          'OAB - English version.',
          'OAB - Version française.',
          'OAB - Deutsche Fassung.',
          '',
        ].join('\n'),
      ),
    );

    const [record] = await fetchAbstracts(['4']);
    expect(record?.abstract).toBe('English version.');
    expect(record?.abstractSource).toBe('publisher');
    expect(record?.otherAbstracts).toEqual([
      'Version française.',
      'Deutsche Fassung.',
    ]);
  });

  it('keeps repeated indexed abstracts apart too, publisher ones after', async () => {
    fetchMock.mockResolvedValue(
      medlineResponse(
        [
          'PMID- 5',
          'AB  - First indexed.',
          'AB  - Second indexed.',
          'OAB - Publisher version.',
          '',
        ].join('\n'),
      ),
    );

    const [record] = await fetchAbstracts(['5']);
    expect(record?.abstract).toBe('First indexed.');
    expect(record?.otherAbstracts).toEqual([
      'Second indexed.',
      'Publisher version.',
    ]);
  });

  it('reports no abstract rather than an empty string', async () => {
    fetchMock.mockResolvedValue(
      medlineResponse(['PMID- 3', 'TI  - A title.', ''].join('\n')),
    );

    const [record] = await fetchAbstracts(['3']);
    expect(record?.abstract).toBeNull();
    expect(record?.abstractSource).toBeNull();
  });
});

describe('NCBI request retries', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetPubMedThrottle();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries a rejected fetch (timeout, DNS, socket reset)', async () => {
    // These reject rather than returning a Response, so before the fix they
    // escaped the retry loop entirely on the first attempt.
    fetchMock
      .mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ esearchresult: { count: '1', idlist: [] } }),
      });

    const result = await searchPubMed({ query: 'aspirin' });
    expect(result.total).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('surfaces the last error once attempts are exhausted', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    await expect(searchPubMed({ query: 'aspirin' })).rejects.toThrow(
      /ENOTFOUND/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('sends a long query as a form-encoded POST', async () => {
    // A 13 KB GET URL gets 414 from NCBI with an HTML body, which surfaces two
    // layers down as a malformed-JSON error.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ esearchresult: { count: '0', idlist: [] } }),
    });

    const longQuery = Array.from({ length: 400 }, (_, i) => `term${i}`).join(
      ' OR ',
    );
    await searchPubMed({ query: longQuery });

    const [target, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(target)).not.toContain('?');
    expect(init?.method).toBe('POST');
    expect(init?.headers?.['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(String(init?.body)).toContain('term399');
  });

  it('keeps an ordinary query on GET', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ esearchresult: { count: '0', idlist: [] } }),
    });

    await searchPubMed({ query: 'postmortem redistribution' });
    const [target, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(target)).toContain('esearch.fcgi?');
    expect(init?.method).toBeUndefined();
  });

  it('retries when the response body fails mid-read', async () => {
    // Headers can arrive fine and the stream still reset afterwards — most
    // likely on large PMC XML. Before the fix this rejected past the loop.
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => {
          throw new Error('terminated');
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ esearchresult: { count: '7', idlist: [] } }),
      });

    const result = await searchPubMed({ query: 'aspirin' });
    expect(result.total).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a body-read failure once attempts are exhausted', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('terminated');
      },
    });

    await expect(searchPubMed({ query: 'aspirin' })).rejects.toThrow(
      /body could not be read/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('waits the interval NCBI asks for on a 429', async () => {
    const sleeps: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      sleeps.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '3' }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ esearchresult: { count: '5', idlist: [] } }),
      });

    const result = await searchPubMed({ query: 'aspirin' });
    expect(result.total).toBe(5);
    // 3s from the header, not the 400ms the fixed backoff would have used.
    expect(sleeps).toContain(3000);
    vi.mocked(globalThis.setTimeout).mockRestore();
  });

  it('gives up rather than burn attempts against a long Retry-After', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '600' }),
      text: async () => '',
    });

    await expect(searchPubMed({ query: 'aspirin' })).rejects.toThrow(
      /Retry-After is 600s/,
    );
    // One attempt only: retrying inside a ten-minute throttle is futile.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to fixed backoff when a 429 carries no Retry-After', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers(),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ esearchresult: { count: '2', idlist: [] } }),
      });

    const result = await searchPubMed({ query: 'aspirin' });
    expect(result.total).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a deterministic 4xx', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => '' });

    await expect(searchPubMed({ query: 'aspirin' })).rejects.toThrow(
      /status 400/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('jatsToText', () => {
  it('keeps section titles and paragraphs, drops tables and references', () => {
    const xml = `<article><front><article-meta><title-group><article-title>Front matter</article-title></title-group></article-meta></front>
      <body>
        <sec><title>Methods</title><p>Femoral blood was collected &amp; analysed.</p>
        <table-wrap><title>Table 1</title><p>should be dropped</p></table-wrap>
        <p>A second <italic>paragraph</italic>.</p></sec>
      </body>
      <back><ref-list><ref><p>Reference one</p></ref></ref-list></back></article>`;

    const text = jatsToText(xml);
    expect(text).toContain('## Methods');
    expect(text).toContain('Femoral blood was collected & analysed.');
    expect(text).toContain('A second paragraph.');
    expect(text).not.toContain('should be dropped');
    expect(text).not.toContain('Reference one');
    // Only <body> is rendered, so front matter never leaks in.
    expect(text).not.toContain('Front matter');
  });

  it('decodes numeric character references', () => {
    expect(jatsToText('<body><p>10&#181;g/mL &#x3b1;</p></body>')).toBe(
      '10µg/mL α',
    );
  });

  it('decodes the named entities that carry meaning in a reported value', () => {
    // Leaving these encoded would put "12.4 &plusmn; 3.1" in front of a model
    // as if it were the article's plain text.
    //
    // Asserted on the whole string, not with toContain: an earlier version of
    // this test checked only the "12.4 ± 3.1 µg/mL" fragment and passed while
    // &frac12; two words later stayed encoded, because the decoder's regex
    // could not match a name containing a digit.
    expect(
      jatsToText(
        '<body><p>C&#x2098;ax 12.4 &plusmn; 3.1 &micro;g/mL, t&frac12; &le; 6 h, ' +
          '&ge; 90&deg;, &alpha;&beta;&Omega;, 5&ndash;10 &mu;M, &times; and &divide;</p></body>',
      ),
    ).toBe(
      'Cₘax 12.4 ± 3.1 µg/mL, t½ ≤ 6 h, ≥ 90°, αβΩ, 5–10 μM, × and ÷',
    );
  });

  it('decodes entity names containing digits', () => {
    // frac12, sup2, frac14, there4 were all in the table but unreachable while
    // the matcher accepted letters only.
    expect(
      jatsToText('<body><p>t&frac12; 5 cm&sup2; &frac14; &sup3; &there4;</p></body>'),
    ).toBe('t½ 5 cm² ¼ ³ ∴');
  });

  it('decodes Latin-1, Greek and punctuation entity blocks', () => {
    expect(jatsToText('<body><p>&le;&ge;&ne;&plusmn;&minus;</p></body>')).toBe(
      '≤≥≠±−',
    );
    expect(jatsToText('<body><p>&alpha;&omega;&Alpha;&Omega;&sigmaf;</p></body>')).toBe(
      'αωΑΩς',
    );
    expect(jatsToText('<body><p>&eacute;&Ouml;&szlig;&aring;&oslash;</p></body>')).toBe(
      'éÖßåø',
    );
    expect(jatsToText('<body><p>a&ndash;b&mdash;c&hellip;&rsquo;</p></body>')).toBe(
      'a–b—c…’',
    );
  });

  it('decodes the ISO Greek aliases the JATS DTDs define', () => {
    // &agr; / &Dgr; alongside the HTML-style &alpha; / &Delta;.
    expect(
      jatsToText('<body><p>&agr;&bgr;&ggr;&dgr; &Agr;&Dgr;&OHgr; &sfgr;</p></body>'),
    ).toBe('αβγδ ΑΔΩ ς');
  });

  it('leaves an unrecognised entity visible rather than guessing', () => {
    expect(jatsToText('<body><p>&notarealentity; x</p></body>')).toBe(
      '&notarealentity; x',
    );
  });

  it('returns nothing for a front-matter-only stub (no <body>)', () => {
    // What PMC actually returns for an article outside the open-access subset
    // (shape taken from PMC29627 and PMC4000000). Flattening this yields
    // hundreds to thousands of characters of publisher metadata; without the
    // <body> requirement it would sail past the length floor and be presented
    // as article text.
    const stub =
      '<article><front><journal-meta>' +
      '<journal-title>Nucleic Acids Research</journal-title>' +
      '<issn pub-type="ppub">0305-1048</issn>' +
      '<publisher><publisher-name>Oxford University Press</publisher-name></publisher>' +
      '</journal-meta><article-meta>' +
      '<article-id pub-id-type="pmc">29627</article-id>' +
      '<article-id pub-id-type="doi">10.1093/nar/29.4.e20</article-id>' +
      '<title-group><article-title>Identification of sample-specific sequences</article-title></title-group>' +
      '<abstract><p>An abstract that is not the article body.</p></abstract>' +
      '</article-meta></front></article>';

    expect(jatsToText(stub)).toBe('');
  });

  it('returns nothing for a document with no markup at all', () => {
    expect(jatsToText('<error>Cannot fetch</error>')).toBe('');
  });
});

describe('citation formatters', () => {
  const record: PubMedRecord = {
    pmid: '33245133',
    title: 'Postmortem drug redistribution.',
    authors: ['Mantinieks D', 'Gerostamoulos D', 'Glowacki L'],
    collectiveAuthors: [],
    journal: 'Journal of Analytical Toxicology',
    journalAbbrev: 'J Anal Toxicol',
    year: 2021,
    publicationDate: '2021 Jan',
    volume: '45',
    issue: '1',
    pages: '10-20',
    doi: '10.1093/jat/bkaa107',
    pmcid: null,
    publicationTypes: ['Journal Article'],
    url: 'https://pubmed.ncbi.nlm.nih.gov/33245133/',
  };

  it('formats Vancouver with the abbreviated journal and PMID', () => {
    const out = CITATION_FORMATTERS.vancouver?.(record) ?? '';
    expect(out).toContain('Mantinieks D, Gerostamoulos D, Glowacki L.');
    expect(out).toContain('J Anal Toxicol. 2021;45(1):10-20.');
    expect(out).toContain('doi:10.1093/jat/bkaa107.');
    expect(out).toContain('PMID: 33245133.');
  });

  it('truncates Vancouver author lists after six names', () => {
    const many = {
      ...record,
      authors: ['A A', 'B B', 'C C', 'D D', 'E E', 'F F', 'G G'],
    };
    expect(CITATION_FORMATTERS.vancouver?.(many)).toContain('F F, et al.');
  });

  it('keeps a generational suffix out of the initials', () => {
    // "Smith AB Jr" must not be read as family "Smith AB" + initials "Jr",
    // which APA would render as "J. r.".
    const suffixed = { ...record, authors: ['Smith AB Jr'] };
    const out = CITATION_FORMATTERS.apa?.(suffixed) ?? '';
    expect(out).toContain('Smith, A. B., Jr');
    expect(out).not.toContain('J. r.');
  });

  it('leaves a collective author whole', () => {
    const collective = {
      ...record,
      authors: ['World Health Organization'],
    };
    const out = CITATION_FORMATTERS.apa?.(collective) ?? '';
    expect(out).toContain('World Health Organization');
    expect(out).not.toContain('O. r.');
  });

  it('formats APA with inverted names and a DOI URL', () => {
    const out = CITATION_FORMATTERS.apa?.(record) ?? '';
    expect(out).toContain('Mantinieks, D.');
    expect(out).toContain('& Glowacki, L.');
    expect(out).toContain('(2021).');
    expect(out).toContain('https://doi.org/10.1093/jat/bkaa107');
  });

  it('formats BibTeX with a stable PMID-derived key', () => {
    const out = CITATION_FORMATTERS.bibtex?.(record) ?? '';
    expect(out).toContain('@article{mantinieks2021pmid33245133,');
    expect(out).toContain('doi = {10.1093/jat/bkaa107}');
  });

  it('writes BibTeX names in comma form so the surname is unambiguous', () => {
    // Unpunctuated, BibTeX reads "Mantinieks D" as First=Mantinieks Last=D and
    // files the entry under "D".
    const out = CITATION_FORMATTERS.bibtex?.(record) ?? '';
    expect(out).toContain(
      'author = {Mantinieks, D and Gerostamoulos, D and Glowacki, L}',
    );
  });

  it('escapes TeX metacharacters in BibTeX fields', () => {
    // `%` is the dangerous one: unescaped it opens a comment and swallows the
    // rest of the line when the bibliography is rendered. `&` occurs in real
    // PubMed titles.
    const hostile = {
      ...record,
      title: 'Response in 50% of patients: safety & efficacy of BRCA_1',
      journal: 'Cost & Value',
      doi: '10.1000/a_b#c',
    };
    const out = CITATION_FORMATTERS.bibtex?.(hostile) ?? '';
    expect(out).toContain(
      'title = {Response in 50\\% of patients: safety \\& efficacy of BRCA\\_1}',
    );
    expect(out).toContain('journal = {Cost \\& Value}');
    expect(out).toContain('doi = {10.1000/a\\_b\\#c}');
    // Only the escaped forms survive.
    expect(out).not.toMatch(/[^\\]%/);
  });

  it('escapes a hostile author name without eating its grouping braces', () => {
    const collective = {
      ...record,
      authors: ['Smith & Sons Research Group'],
    };
    const out = CITATION_FORMATTERS.bibtex?.(collective) ?? '';
    expect(out).toContain('author = {{Smith \\& Sons Research Group}}');
  });

  it('trusts the collective flag over the initials heuristic', () => {
    // "Study Team ABC" ends in something indistinguishable from initials, so
    // only esummary's authtype can tell the formatters it is an organisation.
    const consortium: PubMedRecord = {
      ...record,
      authors: ['Study Team ABC', 'Mantinieks D'],
      collectiveAuthors: ['Study Team ABC'],
    };

    expect(CITATION_FORMATTERS.apa?.(consortium)).toContain('Study Team ABC');
    expect(CITATION_FORMATTERS.apa?.(consortium)).not.toContain('A. B. C.');
    expect(CITATION_FORMATTERS.bibtex?.(consortium)).toContain(
      '{Study Team ABC} and Mantinieks, D',
    );
    expect(CITATION_FORMATTERS.ris?.(consortium)).toContain(
      'AU  - Study Team ABC',
    );
  });

  it('still parses an unflagged name that merely looks collective', () => {
    // Without the flag the heuristic is all we have, and it should keep
    // working for ordinary names.
    const plain: PubMedRecord = { ...record, authors: ['Mantinieks D'] };
    expect(CITATION_FORMATTERS.ris?.(plain)).toContain('AU  - Mantinieks, D.');
  });

  it('braces a collective BibTeX author and orders a suffix Last, Jr, First', () => {
    const mixed = {
      ...record,
      authors: ['World Health Organization', 'Smith AB Jr'],
    };
    const out = CITATION_FORMATTERS.bibtex?.(mixed) ?? '';
    expect(out).toContain('{World Health Organization}');
    expect(out).toContain('Smith, Jr, AB');
  });

  it('truncates an APA author list of 21+ with an ellipsis, not an ampersand', () => {
    // APA 7 §9.8: first 19 authors, an ellipsis, then the final author.
    const many = {
      ...record,
      authors: Array.from({ length: 25 }, (_, i) => `Author${i + 1} X`),
    };
    const out = CITATION_FORMATTERS.apa?.(many) ?? '';
    expect(out).toContain('Author19, X., ... Author25, X.');
    expect(out).not.toContain('&');
    expect(out).not.toContain('Author20');
  });

  it('still uses an ampersand at exactly 20 authors', () => {
    const twenty = {
      ...record,
      authors: Array.from({ length: 20 }, (_, i) => `Author${i + 1} X`),
    };
    const out = CITATION_FORMATTERS.apa?.(twenty) ?? '';
    expect(out).toContain('& Author20, X.');
    expect(out).not.toContain('...');
  });

  it('formats RIS with one AU line per author and a terminator', () => {
    const out = CITATION_FORMATTERS.ris?.(record) ?? '';
    expect(out.startsWith('TY  - JOUR')).toBe(true);
    expect(out.match(/^AU {2}- /gm)).toHaveLength(3);
    expect(out.trimEnd().endsWith('ER  -')).toBe(true);
  });

  it('writes RIS names in comma form and leaves collectives alone', () => {
    const mixed = {
      ...record,
      authors: ['Mantinieks D', 'Smith AB Jr', 'World Health Organization'],
    };
    const out = CITATION_FORMATTERS.ris?.(mixed) ?? '';
    expect(out).toContain('AU  - Mantinieks, D.');
    expect(out).toContain('AU  - Smith, A.B., Jr');
    expect(out).toContain('AU  - World Health Organization');
  });

  it('derives the RIS type from publication metadata', () => {
    // Importing a preprint as a journal article hides the peer-review status
    // this project asks agents to distinguish.
    const preprint = { ...record, publicationTypes: ['Preprint'] };
    expect(CITATION_FORMATTERS.ris?.(preprint)?.startsWith('TY  - UNPB')).toBe(
      true,
    );

    const dataset = { ...record, publicationTypes: ['Dataset'] };
    expect(CITATION_FORMATTERS.ris?.(dataset)?.startsWith('TY  - DATA')).toBe(
      true,
    );

    const news = { ...record, publicationTypes: ['Newspaper Article'] };
    expect(CITATION_FORMATTERS.ris?.(news)?.startsWith('TY  - NEWS')).toBe(true);
  });

  it('picks the BibTeX entry type from publication metadata', () => {
    // @article for a preprint reads as peer-reviewed literature.
    const preprint = { ...record, publicationTypes: ['Preprint'] };
    const out = CITATION_FORMATTERS.bibtex?.(preprint) ?? '';
    expect(out.startsWith('@misc{')).toBe(true);
    expect(out).toContain('note = {Preprint}');

    const report = { ...record, publicationTypes: ['Technical Report'] };
    expect(CITATION_FORMATTERS.bibtex?.(report)?.startsWith('@techreport{')).toBe(
      true,
    );
  });

  it('keeps @article and adds no note for journal content', () => {
    const journal = { ...record, publicationTypes: ['Journal Article'] };
    const out = CITATION_FORMATTERS.bibtex?.(journal) ?? '';
    expect(out.startsWith('@article{')).toBe(true);
    expect(out).not.toContain('note = ');
  });

  it('takes the most specific type when a record carries several', () => {
    const mixed = {
      ...record,
      publicationTypes: ['Journal Article', 'Review', 'Preprint'],
    };
    expect(CITATION_FORMATTERS.ris?.(mixed)?.startsWith('TY  - UNPB')).toBe(
      true,
    );
  });

  it('falls back to JOUR for ordinary journal content', () => {
    for (const types of [
      ['Journal Article'],
      ['Review'],
      ['Journal Article', 'Case Reports'],
      [],
    ]) {
      const r = { ...record, publicationTypes: types };
      expect(CITATION_FORMATTERS.ris?.(r)?.startsWith('TY  - JOUR')).toBe(true);
    }
  });

  it('splits a RIS page range across SP and EP', () => {
    const out = CITATION_FORMATTERS.ris?.(record) ?? '';
    expect(out).toContain('SP  - 10');
    expect(out).toContain('EP  - 20');
  });

  it('expands an abbreviated RIS end page', () => {
    // PubMed writes 368 to 377 as "368-77".
    const out = CITATION_FORMATTERS.ris?.({ ...record, pages: '368-77' }) ?? '';
    expect(out).toContain('SP  - 368');
    expect(out).toContain('EP  - 377');
  });

  it('keeps a non-numeric locator whole in SP', () => {
    const eLocator = CITATION_FORMATTERS.ris?.({ ...record, pages: 'e0234567' }) ?? '';
    expect(eLocator).toContain('SP  - e0234567');
    expect(eLocator).not.toContain('EP  -');

    const supplement = CITATION_FORMATTERS.ris?.({ ...record, pages: 'S1-S5' }) ?? '';
    expect(supplement).toContain('SP  - S1-S5');
  });

  it('omits missing fields instead of emitting empty markers', () => {
    const sparse: PubMedRecord = {
      ...record,
      doi: null,
      volume: null,
      issue: null,
      pages: null,
      year: null,
    };
    const out = CITATION_FORMATTERS.vancouver?.(sparse) ?? '';
    expect(out).not.toContain('doi:');
    expect(out).not.toContain('();');
    expect(out).toContain('PMID: 33245133.');
  });
});
