/**
 * The route (plan §10, Phase 1): a case is entered, filed, and reopened.
 *
 * What is pinned is the round trip through the URL — the id in the address is
 * what makes a filed case findable again, and a save that does not put it there
 * leaves the curator on a page that looks like a draft of work already stored.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import nb from '../locales/nb.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'nb' },
    t: (key: string, options?: Record<string, unknown>) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (node, part) =>
            node && typeof node === 'object' && part in node
              ? (node as Record<string, unknown>)[part]
              : undefined,
          nb,
        );
      if (typeof value !== 'string') return (options?.defaultValue as string) ?? key;
      return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(options?.[name] ?? `{{${name}}}`),
      );
    },
  }),
}));

import { PatternCasePage } from './PatternCasePage';
import { DIAZEPAM_FIXTURE_CASE } from '../lib/pattern/fixtures';
import { BENZODIAZEPINE_MODULE } from '../lib/pattern/modules/benzodiazepines';
import { usePatternCaseStore, emptyPatternCase } from '../stores/patternCaseStore';

const STORED = {
  id: 7,
  name: 'Sak TEST-001',
  // Saved under the version the app ships, so nothing reads as stale here.
  caseData: {
    ...DIAZEPAM_FIXTURE_CASE,
    moduleVersions: { benzodiazepines: BENZODIAZEPINE_MODULE.version },
  },
  createdAt: 'now',
};

let posted: unknown[] = [];
let sentUrls: string[] = [];

beforeEach(() => {
  posted = [];
  sentUrls = [];
  // jsdom has no confirm dialog. Most tests here never reach one; the ones
  // about unsaved work drive it themselves.
  vi.stubGlobal('confirm', () => true);
  usePatternCaseStore.setState({
    caseId: null,
    caseName: '',
    data: emptyPatternCase('benzodiazepines'),
    status: 'idle',
    error: null,
    dirty: false,
  });
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    sentUrls.push(url);
    const body = (): unknown => {
      if (url.startsWith('/api/metabolism-graph')) return { graph: { nodes: [], edges: [] } };
      if (url.includes('kind=pattern-case')) return { cases: [STORED] };
      if (init?.method === 'POST' || init?.method === 'PUT') {
        posted.push(JSON.parse(String(init.body)));
        return { ...STORED, id: 12 };
      }
      // Answer for the id that was asked for: the page keys the editor and
      // the profile by the case on screen, so a mock that always said "7"
      // would hide a remount that does not happen.
      const asked = Number(new URLSearchParams(url.split('?')[1] ?? '').get('id'));
      return Number.isInteger(asked) && asked > 0 ? { ...STORED, id: asked } : STORED;
    };
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body()),
      text: () => Promise.resolve(''),
    } as Response);
  });
});
afterEach(() => vi.unstubAllGlobals());

/** A way to change route inside the test's own router. */
function Nav({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      gå
    </button>
  );
}

function NavBack() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/modeling/pattern')}>
      tilbake
    </button>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/modeling/pattern" element={<PatternCasePage />} />
        <Route path="/modeling/pattern/:caseId" element={<PatternCasePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('the pattern case route', () => {
  it('opens the case the address names', async () => {
    renderAt('/modeling/pattern/7');

    await waitFor(() =>
      expect((screen.getByLabelText('Saksnavn') as HTMLInputElement).value).toBe('Sak TEST-001'),
    );
    // The stored case, not a draft that happens to share its name: the
    // observations came back with it.
    expect(usePatternCaseStore.getState().data.observations).toHaveLength(
      DIAZEPAM_FIXTURE_CASE.observations.length,
    );
    // Nothing to warn about — it was filed under the version now loading it.
    expect(screen.queryByText(/Registeret har endret seg/)).toBeNull();
  });

  it('puts a newly filed case in the address', async () => {
    renderAt('/modeling/pattern');

    fireEvent.change(screen.getByLabelText('Saksnavn'), { target: { value: 'Ny sak' } });
    fireEvent.click(screen.getByText('Lagre'));

    await waitFor(() => expect(posted).toHaveLength(1));
    // Filed under the name typed, with the registry stamped for it — the save
    // path takes the stamp so a caller cannot forget it.
    expect((posted[0] as { name: string }).name).toBe('Ny sak');
    expect((posted[0] as { caseData: { moduleVersions: unknown } }).caseData.moduleVersions).toEqual(
      { benzodiazepines: BENZODIAZEPINE_MODULE.version },
    );
    await waitFor(() => expect(usePatternCaseStore.getState().caseId).toBe(12));
  });

  it('does not tell a curator their filed work is gone when the list request failed', async () => {
    vi.stubGlobal('fetch', (url: string) =>
      url.includes('kind=pattern-case')
        ? Promise.reject(new Error('network'))
        : Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ graph: { nodes: [], edges: [] } }),
            text: () => Promise.resolve(''),
          } as Response),
    );
    renderAt('/modeling/pattern');

    // An expired session or a dropped connection must not render as an empty
    // shelf: "you have no saved cases" is the one answer this list can give
    // that a curator would act on and be wrong.
    await waitFor(() => expect(screen.getByText(/Fikk ikke hentet listen/)).toBeTruthy());
    expect(screen.queryByText('Ingen lagrede saker ennå.')).toBeNull();
    expect(screen.getByText('Prøv igjen')).toBeTruthy();
  });

  it('keeps a correction made on the profile, and does not carry it to another case', async () => {
    render(
      <MemoryRouter initialEntries={['/modeling/pattern/7']}>
        <Nav to="/modeling/pattern/8" />
        <Routes>
          <Route path="/modeling/pattern/:caseId" element={<PatternCasePage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(usePatternCaseStore.getState().caseId).toBe(7));

    // A correction made on the profile is case data, not a scratch layer over
    // it: it decides what the assessment says, so filing the case has to file
    // it too.
    const value = screen
      .getAllByDisplayValue('315,39')
      .find((node) => (node as HTMLInputElement).className.includes('w-28'))!;
    fireEvent.change(value, { target: { value: '4242' } });

    const edited = usePatternCaseStore.getState().data.observations.find((o) => o.id === 'obs-dzp-b');
    expect(edited?.value).toBe(4242);
    expect(usePatternCaseStore.getState().dirty).toBe(true);

    // And it belongs to that case alone. Observation ids restart at `obs-1`
    // between cases, so anything kept beside the case would land on the next
    // one's profile against an editor showing the stored values.
    fireEvent.click(screen.getByText('gå'));
    await waitFor(() => expect(screen.queryByDisplayValue('4242')).toBeNull());
  });

  it('does not count a page of saved cases twice', async () => {
    // Twenty rows, so the picker offers another page.
    const page = (offset: number) =>
      Array.from({ length: 20 }, (_, index) => ({
        ...STORED,
        id: offset + index + 1,
        name: `Sak ${offset + index + 1}`,
      }));
    vi.stubGlobal('fetch', (url: string) => {
      const body = url.startsWith('/api/metabolism-graph')
        ? { graph: { nodes: [], edges: [] } }
        : url.includes('kind=pattern-case')
          ? { cases: page(Number(new URLSearchParams(url.split('?')[1]).get('offset') ?? 0)) }
          : STORED;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(''),
      } as Response);
    });

    render(
      <MemoryRouter initialEntries={['/modeling/pattern']}>
        <Nav to="/modeling/pattern/7" />
        <NavBack />
        <Routes>
          <Route path="/modeling/pattern" element={<PatternCasePage />} />
          <Route path="/modeling/pattern/:caseId" element={<PatternCasePage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Sak 1')).toBeTruthy());
    fireEvent.click(screen.getByText('Vis flere'));
    await waitFor(() => expect(screen.getByText('Sak 21')).toBeTruthy());

    // Open a case and come back. The list request runs again with the offset
    // last asked for; counting that page twice would put "show more" past the
    // rows in between, and they would be unreachable from the picker.
    fireEvent.click(screen.getByText('gå'));
    await waitFor(() => expect(usePatternCaseStore.getState().caseId).toBe(7));
    fireEvent.click(screen.getByText('tilbake'));

    // Back to the first page, and only that. The endpoint orders by when a
    // case was last touched, so a save moves that case onto page one — a
    // cached page from before would show the list without it and repeat
    // another row across the stale and refreshed pages.
    await waitFor(() => expect(screen.getByText('Sak 1')).toBeTruthy());
    expect(screen.queryByText('Sak 21')).toBeNull();
    expect(screen.getAllByText('Sak 1')).toHaveLength(1);
  });

  it('files the context selections the profile offers', async () => {
    renderAt('/modeling/pattern/7');
    await waitFor(() => expect(usePatternCaseStore.getState().caseId).toBe(7));

    // Hydrolysis protocol, genotype, matrix provenance: each decides which
    // artefact warnings fire and which signals are computable. Kept beside the
    // case, a curator could set one, read the assessment it produced, file the
    // case, and reopen it showing a different assessment made from defaults.
    const hydrolysis = screen.getByLabelText('Hydrolyseprotokoll') as HTMLSelectElement;
    fireEvent.change(hydrolysis, { target: { value: 'snail' } });

    expect(usePatternCaseStore.getState().data.context.fields.hydro).toBe('snail');
    expect(usePatternCaseStore.getState().dirty).toBe(true);
  });

  it('does not reload over edits made while the case was being filed', async () => {
    renderAt('/modeling/pattern');
    fireEvent.change(screen.getByLabelText('Saksnavn'), { target: { value: 'Ny sak' } });
    fireEvent.click(screen.getByText('Lagre'));
    await waitFor(() => expect(usePatternCaseStore.getState().caseId).toBe(12));

    // The address now names the filed case, and this effect runs. Fetching the
    // server's copy here would replace a working copy that may have moved on
    // since the request went out — undoing exactly what the store kept.
    await waitFor(() => expect(usePatternCaseStore.getState().status).toBe('idle'));
    expect(usePatternCaseStore.getState().caseName).toBe('Ny sak');
    expect(
      sentUrls.filter((url) => /\/api\/simulator\/cases\?id=12/.test(url)),
    ).toHaveLength(0);
  });

  it('withholds the profile when the metabolism graph never arrived', async () => {
    vi.stubGlobal('fetch', (url: string) =>
      url.startsWith('/api/metabolism-graph')
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({
            ok: true,
            json: () => Promise.resolve(STORED),
            text: () => Promise.resolve(''),
          } as Response),
    );
    renderAt('/modeling/pattern/7');

    // An empty graph is a real answer — a module nobody has entered edges for —
    // and the walk reads it as a curation gap that degrades every
    // source-dependent signal. Substituting it for a failed request would turn
    // a network fault into a forensic statement about the database.
    await waitFor(() => expect(screen.getByText(/Fikk ikke hentet metabolismegrafen/)).toBeTruthy());
    expect(screen.queryByText('Metabolittprofil — vurdering')).toBeNull();
  });

  it('will not let the previous case be edited or filed under another case’s address', async () => {
    let release: (() => void) | undefined;
    vi.stubGlobal('fetch', (url: string) => {
      if (url.startsWith('/api/metabolism-graph')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ graph: { nodes: [], edges: [] } }),
          text: () => Promise.resolve(''),
        } as Response);
      }
      if (usePatternCaseStore.getState().caseId === 7) {
        // The second case, held open.
        return new Promise<Response>((resolve) => {
          release = () =>
            resolve({
              ok: true,
              json: () => Promise.resolve({ ...STORED, id: 8, name: 'Sak 8' }),
              text: () => Promise.resolve(''),
            } as Response);
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(STORED),
        text: () => Promise.resolve(''),
      } as Response);
    });

    render(
      <MemoryRouter initialEntries={['/modeling/pattern/7']}>
        <Nav to="/modeling/pattern/8" />
        <Routes>
          <Route path="/modeling/pattern/:caseId" element={<PatternCasePage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(usePatternCaseStore.getState().caseId).toBe(7));
    fireEvent.click(screen.getByText('gå'));

    // Case 7 is still the case in hand while case 8 is on its way in. Saving
    // now would file 7 under 8's address — and everything below the header
    // writes, so none of it is there.
    await waitFor(() => expect(screen.getByText(/Henter sak 8/)).toBeTruthy());
    expect((screen.getByText('Lagre') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('Legg til prøve')).toBeNull();
    // And the store refuses even if something asks it directly.
    expect(await usePatternCaseStore.getState().save([BENZODIAZEPINE_MODULE])).toBeNull();

    release?.();
    await waitFor(() => expect(usePatternCaseStore.getState().caseId).toBe(8));
    expect(screen.getByText('Legg til prøve')).toBeTruthy();
  });

  it('will not file a case while a field holds something it cannot take', async () => {
    renderAt('/modeling/pattern');
    fireEvent.change(screen.getByLabelText('Saksnavn'), { target: { value: 'Ny sak' } });
    fireEvent.click(screen.getByText('Legg til prøve'));

    fireEvent.change(screen.getByLabelText('Prøvetaking (timer fra nullpunkt)'), {
      target: { value: '1,500' },
    });

    // The problem list is silent here: the case is valid, because those
    // keystrokes never reached it. So the screen shows one number while the
    // case holds another, and a save filed at this moment writes the one being
    // replaced — a concentration nobody typed.
    await waitFor(() =>
      expect((screen.getByText('Lagre') as HTMLButtonElement).disabled).toBe(true),
    );
    expect(screen.getByText(/Et felt inneholder noe saken ikke kan ta imot/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Prøvetaking (timer fra nullpunkt)'), {
      target: { value: '0' },
    });
    await waitFor(() =>
      expect((screen.getByText('Lagre') as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it('says an address that names no case is not a case', async () => {
    renderAt('/modeling/pattern/foo');

    // Read as a case that has not arrived, the screen would wait for a load
    // nobody started — and the retry button would ask the server about "foo".
    await waitFor(() => expect(screen.getByText(/er ikke et saksnummer/)).toBeTruthy());
    expect(screen.queryByText('Prøv igjen')).toBeNull();
    expect(screen.getByText('Gå til lagrede saker')).toBeTruthy();
    expect(sentUrls.filter((url) => /simulator\/cases\?id=/.test(url))).toHaveLength(0);
  });

  it('says why a case could not be filed, in the reader’s language', async () => {
    renderAt('/modeling/pattern');
    // A case with no name cannot be saved at all, so give it one and break the
    // case instead: an observation the schema refuses.
    fireEvent.change(screen.getByLabelText('Saksnavn'), { target: { value: 'Ny sak' } });
    fireEvent.click(screen.getByText('Legg til prøve'));
    fireEvent.click(screen.getByText('Legg til måling'));
    fireEvent.click(screen.getByText('Lagre'));

    // The store carries a code, not the schema's English prose — the same rule
    // that governs the inline problem list (AGENTS.md).
    await waitFor(() =>
      expect(screen.getByText(/Saken kan ikke lagres slik den står/)).toBeTruthy(),
    );
  });

  it('stops handing the example its own graph once the case has changed', async () => {
    renderAt('/modeling/pattern');
    const graphRequests = () => sentUrls.filter((url) => url.startsWith('/api/metabolism-graph')).length;
    await waitFor(() => expect(graphRequests()).toBeGreaterThan(0));
    const beforeExample = graphRequests();

    fireEvent.click(screen.getByText('Last inn eksempelsaken'));

    // The example is the benzodiazepine fixture, and its graph comes from the
    // fixture too — nothing is asked of the server for it.
    await waitFor(() => expect(screen.getByText(/Demonstrasjonsdata/)).toBeTruthy());
    expect(graphRequests()).toBe(beforeExample);

    // Ticking a second module makes it a case like any other. Keeping the
    // fixture graph would evaluate cocaine observations against a graph that
    // cannot contain their nodes, and report that as a curation gap rather
    // than as the wrong graph.
    fireEvent.click(screen.getByLabelText('Kokain'));
    await waitFor(() => expect(graphRequests()).toBeGreaterThan(beforeExample));
  });

  it('does not let a case land on the draft route it was navigated away from', async () => {
    let release: (() => void) | undefined;
    vi.stubGlobal('fetch', (url: string) => {
      if (url.startsWith('/api/metabolism-graph')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ graph: { nodes: [], edges: [] } }),
          text: () => Promise.resolve(''),
        } as Response);
      }
      if (url.includes('kind=pattern-case')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ cases: [] }),
          text: () => Promise.resolve(''),
        } as Response);
      }
      return new Promise<Response>((resolve) => {
        release = () =>
          resolve({
            ok: true,
            json: () => Promise.resolve(STORED),
            text: () => Promise.resolve(''),
          } as Response);
      });
    });

    render(
      <MemoryRouter initialEntries={['/modeling/pattern/7']}>
        <Nav to="/modeling/pattern" />
        <Routes>
          <Route path="/modeling/pattern" element={<PatternCasePage />} />
          <Route path="/modeling/pattern/:caseId" element={<PatternCasePage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/Henter sak 7/)).toBeTruthy());

    // Back to the draft route before case 7 arrives. The draft has no id, so a
    // check on "is a case loaded" would let the late answer through — and it
    // would install case 7 under an address that names no case at all, from
    // where the next save writes to it.
    fireEvent.click(screen.getByText('gå'));
    release?.();

    await waitFor(() => expect(screen.getByText('Legg til prøve')).toBeTruthy());
    expect(usePatternCaseStore.getState().caseId).toBeNull();
    expect(usePatternCaseStore.getState().caseName).toBe('');
  });

  it('follows the case when its module scope changes', async () => {
    renderAt('/modeling/pattern/7');
    await waitFor(() => expect(usePatternCaseStore.getState().caseId).toBe(7));
    // Filed under the version now loading it, so nothing to say yet.
    expect(screen.queryByText(/sier ikke hvilken versjon/)).toBeNull();

    fireEvent.click(screen.getByLabelText('Kokain'));

    // A module the case was not filed under has no stamp, and the stamp is
    // what the marker reads. Remembered from the load, the answer would keep
    // describing the scope the case had when it arrived.
    await waitFor(() => expect(screen.getByText(/sier ikke hvilken versjon/)).toBeTruthy());
  });

  it('asks before throwing away casework that exists nowhere else', async () => {
    const asked: string[] = [];
    vi.stubGlobal('confirm', (message: string) => {
      asked.push(message);
      return false;
    });

    render(
      <MemoryRouter initialEntries={['/modeling/pattern/7']}>
        <NavBack />
        <Routes>
          <Route path="/modeling/pattern" element={<PatternCasePage />} />
          <Route path="/modeling/pattern/:caseId" element={<PatternCasePage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(usePatternCaseStore.getState().caseId).toBe(7));

    fireEvent.change(screen.getByLabelText('Saksnavn'), { target: { value: 'Rettet navn' } });
    expect(usePatternCaseStore.getState().dirty).toBe(true);

    // Browser Back with unsaved specimens and observations. The store is not
    // persisted, so the working copy is the only copy — and it would go
    // without a word.
    fireEvent.click(screen.getByText('tilbake'));

    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toMatch(/ikke er lagret/);
    // Declined, so the case is still here and the address is back where it
    // lives.
    expect(usePatternCaseStore.getState().caseId).toBe(7);
    expect(usePatternCaseStore.getState().caseName).toBe('Rettet navn');
    await waitFor(() => expect(screen.getByText('Legg til prøve')).toBeTruthy());
  });

  it('asks before the example replaces a draft the curator has entered', async () => {
    // The address does not move when the example is loaded, so the route
    // effect's question never gets asked — and a draft entered on
    // `/modeling/pattern` exists nowhere but the store.
    const asked: string[] = [];
    vi.stubGlobal('confirm', (message: string) => {
      asked.push(message);
      return false;
    });

    renderAt('/modeling/pattern');
    await waitFor(() => expect(screen.getByText('Last inn eksempelsaken')).toBeTruthy());
    fireEvent.click(screen.getByText('Legg til prøve'));
    await waitFor(() => expect(usePatternCaseStore.getState().dirty).toBe(true));
    const entered = usePatternCaseStore.getState().data;

    fireEvent.click(screen.getByText('Last inn eksempelsaken'));

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/ikke er lagret/);
    // Declined, so the specimen the curator entered is still the case.
    expect(usePatternCaseStore.getState().data).toBe(entered);
    expect(screen.queryByText(/Demonstrasjonsdata/)).toBeNull();
  });

  it('keeps saying the case is the example after a visit elsewhere', async () => {
    // The case outlives the page: the store is a module-level singleton and
    // the working copy survives leaving for another part of the app. A marker
    // remembered in the component does not, and the demonstration data would
    // come back looking like ordinary casework — with its live-graph
    // assessment rather than the fixture's, and nothing saying which.
    const { unmount } = renderAt('/modeling/pattern');
    await waitFor(() => expect(screen.getByText('Last inn eksempelsaken')).toBeTruthy());
    fireEvent.click(screen.getByText('Last inn eksempelsaken'));
    await waitFor(() => expect(screen.getByText(/Demonstrasjonsdata/)).toBeTruthy());

    const graphRequests = () => sentUrls.filter((url) => url.startsWith('/api/metabolism-graph')).length;
    const before = graphRequests();
    unmount();
    renderAt('/modeling/pattern');

    await waitFor(() => expect(screen.getByText(/Demonstrasjonsdata/)).toBeTruthy());
    // And still on the fixture's own graph, not the live one.
    expect(graphRequests()).toBe(before);
  });

  it('keeps saying the case is the example after it is filed', async () => {
    // Filing is the moment the warning is worth most: the demonstration's
    // invented concentrations go into the curator's case list, and the saved
    // case comes back as an object the page has never seen. A marker read from
    // the object in hand would drop exactly there.
    renderAt('/modeling/pattern');
    await waitFor(() => expect(screen.getByText('Last inn eksempelsaken')).toBeTruthy());
    fireEvent.click(screen.getByText('Last inn eksempelsaken'));
    await waitFor(() => expect(screen.getByText(/Demonstrasjonsdata/)).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Saksnavn'), { target: { value: 'Ny sak' } });
    fireEvent.click(screen.getByText('Lagre'));
    await waitFor(() => expect(usePatternCaseStore.getState().caseId).toBe(12));

    // The case really is a different object now, and still says where it came
    // from — because the case says it, not the page.
    expect(usePatternCaseStore.getState().data).not.toBe(DIAZEPAM_FIXTURE_CASE);
    expect((posted[0] as { caseData: { origin?: string } }).caseData.origin).toBe('example');
    expect(screen.getByText(/Demonstrasjonsdata/)).toBeTruthy();
  });

  it('will not file a case while the profile’s own field holds something it cannot take', async () => {
    // The profile edits concentrations as well as the editor, and its fields
    // keep the previous value underneath the draft — so a save while `1,500` is
    // on screen files the concentration the curator was replacing, and clicking
    // Save blurs the draft away before they can see it happened.
    renderAt('/modeling/pattern/7');
    await waitFor(() => expect(usePatternCaseStore.getState().caseId).toBe(7));

    // The profile's own concentration field, by the class its narrow input
    // carries — the editor holds the same value in a field of its own.
    const field = screen
      .getAllByDisplayValue('315,39')
      .find((node) => (node as HTMLInputElement).className.includes('w-28'))!;
    fireEvent.change(field, { target: { value: '1,500' } });

    await waitFor(() => expect(screen.getByText(/Lagre/).closest('button')!.disabled).toBe(true));
    // A cleared field blocks too, though it shows no message. The editor can
    // answer an emptied number by clearing the case's own; a concentration
    // reached through the profile has no such patch, so the observation goes on
    // holding the value the curator was in the middle of removing.
    fireEvent.change(field, { target: { value: '' } });
    await waitFor(() => expect(screen.getByText(/Lagre/).closest('button')!.disabled).toBe(true));

    // And the way back is the same as the editor's: make it readable again.
    fireEvent.change(field, { target: { value: '1,5' } });
    await waitFor(() => expect(screen.getByText(/Lagre/).closest('button')!.disabled).toBe(false));
  });

  it('does not take a case name while another case is on its way in', async () => {
    // Everything else about the case being left is already off screen while a
    // load is in flight — the editor is hidden and Save is disabled — and the
    // name was the one field still writing to it. Typed there, it is either
    // dropped when the new case lands or attached to whichever case arrives.
    let release: (() => void) | undefined;
    vi.stubGlobal('fetch', (url: string) => {
      if (url.startsWith('/api/metabolism-graph')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ graph: { nodes: [], edges: [] } }),
          text: () => Promise.resolve(''),
        } as Response);
      }
      if (url.includes('kind=pattern-case')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ cases: [STORED] }),
          text: () => Promise.resolve(''),
        } as Response);
      }
      return new Promise<Response>((resolve) => {
        release = () =>
          resolve({
            ok: true,
            json: () => Promise.resolve(STORED),
            text: () => Promise.resolve(''),
          } as Response);
      });
    });

    renderAt('/modeling/pattern/7');
    await waitFor(() =>
      expect((screen.getByLabelText('Saksnavn') as HTMLInputElement).disabled).toBe(true),
    );

    release?.();
    await waitFor(() =>
      expect((screen.getByLabelText('Saksnavn') as HTMLInputElement).disabled).toBe(false),
    );
  });

  it('says the registry moved rather than recomputing in silence', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ...STORED,
            caseData: { ...STORED.caseData, moduleVersions: { benzodiazepines: '0.0.1' } },
          }),
        text: () => Promise.resolve(''),
      } as Response),
    );
    renderAt('/modeling/pattern/7');

    // The whole reason the versions travel with the case: the profile below is
    // recomputed from the current registry, and an unexplained change of
    // assessment is worse in a forensic setting than a stated one.
    await waitFor(() => expect(screen.getByText(/Registeret har endret seg/)).toBeTruthy());
    expect(screen.getByText(new RegExp(`0\\.0\\.1 → ${BENZODIAZEPINE_MODULE.version}`))).toBeTruthy();
  });
});
