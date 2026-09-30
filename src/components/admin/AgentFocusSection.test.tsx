/**
 * The admin focus form, and specifically the one field it must not infer.
 *
 * `skipWikiContent` in the API response is the EFFECTIVE answer: it reads true
 * under `mode = 'parameters'` whatever the switch is set to, because that mode
 * closes agent wiki authoring on its own. Binding the checkbox to it made the
 * form unable to tell a ticked box from an implied one, and the next save
 * under any other mode wrote back the value it had guessed — silently erasing
 * a guard the admin never touched, or asserting one they never chose.
 *
 * The form binds to `skipWikiContentSetting` instead. These tests drive the
 * exact sequence that used to lose it: load under a parameter focus, switch
 * the scope, save.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentFocusSection } from './AgentFocusSection';
import type { AgentFocusConfig } from '@/lib/agentFocusApi';

const translate = (key: string) => key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'nb' } }),
}));

const { fetchMock, updateMock, searchMock, methodsMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  updateMock: vi.fn(),
  searchMock: vi.fn(),
  methodsMock: vi.fn(),
}));

vi.mock('@/lib/agentFocusApi', () => ({
  fetchAgentFocusConfig: fetchMock,
  updateAgentFocusConfig: updateMock,
  searchWikiPages: searchMock,
}));

vi.mock('@/lib/drugApi', () => ({ fetchMethods: methodsMock }));

function config(over: Partial<AgentFocusConfig> = {}): AgentFocusConfig {
  return {
    mode: 'all',
    pageIds: [],
    parameters: [],
    methodIds: [],
    skipWikiContent: false,
    skipWikiContentSetting: false,
    updatedAt: null,
    pages: [],
    methods: [],
    ...over,
  };
}

/** The mode radios, in the order the form renders them. */
const MODE_INDEX = { all: 0, pages: 1, parameters: 2, methods: 3 } as const;

/** The wiki switch is the first checkbox — it sits above every panel. */
function wikiSwitch(): HTMLInputElement {
  return screen.getAllByRole('checkbox')[0] as HTMLInputElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  searchMock.mockResolvedValue([]);
  methodsMock.mockResolvedValue({ methods: [], gated: false });
  updateMock.mockImplementation(async (payload: { mode: string }) =>
    config({ mode: payload.mode as AgentFocusConfig['mode'] }),
  );
});

describe('AgentFocusSection — the wiki switch', () => {
  it('keeps a stored switch when the admin changes scope away from parameters', async () => {
    // The regression. Under `parameters` the effective value is true whatever
    // the setting is, so a form reading it could not preserve a real tick
    // through a mode change — it wrote back the `false` it had assumed, and
    // agent wiki authoring reopened on a save that was about the scope.
    fetchMock.mockResolvedValue(
      config({
        mode: 'parameters',
        parameters: ['halfLife'],
        skipWikiContent: true,
        skipWikiContentSetting: true,
      }),
    );
    render(<AgentFocusSection />);

    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(4));
    fireEvent.click(screen.getAllByRole('radio')[MODE_INDEX.methods]!);
    fireEvent.click(screen.getByRole('button', { name: 'agentFocus.save' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    const payload = updateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.mode).toBe('methods');
    // Preserved by being left out — the stored `true` stands untouched. What
    // must never happen is this payload carrying `skipWikiContent: false`,
    // which is exactly what a form reading the effective value produced.
    expect(payload.skipWikiContent).not.toBe(false);
  });

  it('does not adopt the switch that parameters mode merely implies', async () => {
    // The mirror image, and why the effective value cannot simply be stored:
    // the box shows ticked under `parameters` because the mode closes the
    // action, but nothing was chosen, so moving to another scope must leave
    // the switch off rather than assert a guard the admin never set.
    fetchMock.mockResolvedValue(
      config({
        mode: 'parameters',
        parameters: ['halfLife'],
        skipWikiContent: true,
        skipWikiContentSetting: false,
      }),
    );
    render(<AgentFocusSection />);

    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(4));
    expect(wikiSwitch().checked).toBe(true);
    expect(wikiSwitch().disabled).toBe(true);

    fireEvent.click(screen.getAllByRole('radio')[MODE_INDEX.methods]!);
    expect(wikiSwitch().checked).toBe(false);
    expect(wikiSwitch().disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'agentFocus.save' }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    const payload = updateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.mode).toBe('methods');
    // Nothing was decided here either way, so the save asserts nothing about
    // the guard: the stored `false` stands, and had another admin ticked it
    // meanwhile, their tick would stand too.
    expect(payload.skipWikiContent).not.toBe(true);
  });

  it('omits the switch from a save that did not change it', async () => {
    // Otherwise every save asserts the guard, including one that was about the
    // scope: two admins with the form open, one ticks the switch, the other
    // saves a mode change from a tab loaded before that — and the second
    // request posts the `false` it loaded, reopening agent wiki authoring.
    // Omitting the field is the defined way to say "unchanged".
    fetchMock.mockResolvedValue(config({ mode: 'all' }));
    render(<AgentFocusSection />);

    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(4));
    fireEvent.click(screen.getAllByRole('radio')[MODE_INDEX.methods]!);
    fireEvent.click(screen.getByRole('button', { name: 'agentFocus.save' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    const payload = updateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.mode).toBe('methods');
    expect('skipWikiContent' in payload).toBe(false);
  });

  it('omits the switch when a tick is undone before saving', async () => {
    // Compared against the loaded value rather than tracked as "touched", so
    // ticking and unticking again is the no-op it looks like — and still does
    // not overwrite whatever another admin stored in the meantime.
    fetchMock.mockResolvedValue(config({ mode: 'methods', methodIds: [9001] }));
    render(<AgentFocusSection />);

    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(4));
    fireEvent.click(wikiSwitch());
    fireEvent.click(wikiSwitch());
    fireEvent.click(screen.getByRole('button', { name: 'agentFocus.save' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    const payload = updateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect('skipWikiContent' in payload).toBe(false);
  });

  it('sends an explicit untick so the guard can be lifted on purpose', async () => {
    // The other direction of the same rule: omitting a real change would make
    // the switch impossible to turn off.
    fetchMock.mockResolvedValue(
      config({
        mode: 'methods',
        methodIds: [9001],
        skipWikiContent: true,
        skipWikiContentSetting: true,
      }),
    );
    render(<AgentFocusSection />);

    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(4));
    expect(wikiSwitch().checked).toBe(true);

    fireEvent.click(wikiSwitch());
    fireEvent.click(screen.getByRole('button', { name: 'agentFocus.save' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock.mock.calls[0]![0]).toMatchObject({
      skipWikiContent: false,
    });
  });

  it('sends the switch an admin ticks alongside a method scope', async () => {
    // The pairing the whole feature exists for: keep the panel scope, close
    // the monograph half.
    fetchMock.mockResolvedValue(config({ mode: 'methods', methodIds: [9001] }));
    render(<AgentFocusSection />);

    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(4));
    expect(wikiSwitch().checked).toBe(false);

    fireEvent.click(wikiSwitch());
    fireEvent.click(screen.getByRole('button', { name: 'agentFocus.save' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock.mock.calls[0]![0]).toMatchObject({
      mode: 'methods',
      methodIds: [9001],
      skipWikiContent: true,
    });
  });
});
