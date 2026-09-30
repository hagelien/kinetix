/**
 * Covers the model-tier control (#319 follow-up): the tier is visible on every
 * row, editable from the admin UI rather than only via a raw PATCH, and a
 * promotion to flagship — the one direction that widens what an identity can
 * wave through on its own — is confirmed before it is sent.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsAdminSection } from './AgentsAdminSection';
import type { AgentAdminRow } from '@/lib/agentsApi';

const translate = (key: string, opts?: Record<string, unknown>) =>
  (opts?.defaultValue as string) ?? key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'en' } }),
}));

const fetchAdminAgents = vi.fn();
const patchAgent = vi.fn();
const setAgentRole = vi.fn();
const createAgent = vi.fn();
vi.mock('@/lib/agentsApi', () => ({
  fetchAdminAgents: (...a: unknown[]) => fetchAdminAgents(...a),
  patchAgent: (...a: unknown[]) => patchAgent(...a),
  setAgentRole: (...a: unknown[]) => setAgentRole(...a),
  createAgent: (...a: unknown[]) => createAgent(...a),
  issueAgentToken: vi.fn(),
  listAgentTokens: vi.fn(async () => ({ tokens: [] })),
  revokeAgentToken: vi.fn(),
  transitionAgent: vi.fn(),
}));

function agentRow(overrides: Partial<AgentAdminRow> = {}): AgentAdminRow {
  return {
    id: 7,
    userId: 42,
    name: 'Kinetix Agent',
    nameEn: null,
    slug: 'kinetix-agent',
    description: null,
    descriptionEn: null,
    maintainerUserId: null,
    status: 'active',
    statusChangedBy: null,
    statusChangedAt: null,
    statusChangeReason: null,
    preSuspensionRole: null,
    hooksEnabled: false,
    selfReviewEnabled: false,
    modelTier: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    username: 'kinetix-agent',
    email: 'agent@example.com',
    userRole: 'contributor',
    history: [],
    ...overrides,
  };
}

/** The (id, payload) of the first patch, once one has been sent. */
function firstPatch(): [number, Record<string, unknown>] {
  const call = patchAgent.mock.calls[0];
  if (!call) throw new Error('patchAgent was not called');
  return call as [number, Record<string, unknown>];
}

/** Open the row's edit form and return the tier dropdown. */
async function openTierSelect(): Promise<HTMLSelectElement> {
  fireEvent.click(await screen.findByText('Edit'));
  return screen.getByLabelText('Model tier') as HTMLSelectElement;
}

/** Open the create form and fill the fields the browser marks required. */
function openCreateForm(): HTMLSelectElement {
  fireEvent.click(screen.getByText('New agent'));
  const selects = screen.getAllByLabelText('Model tier');
  return selects[0] as HTMLSelectElement;
}

beforeEach(() => {
  patchAgent.mockResolvedValue({ agent: agentRow() });
  setAgentRole.mockResolvedValue({ agent: agentRow(), role: 'contributor' });
  createAgent.mockResolvedValue({ agent: agentRow(), user: { id: 1 } });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('AgentsAdminSection model tier', () => {
  it('shows the tier on the row, unclassified included', async () => {
    fetchAdminAgents.mockResolvedValue({
      agents: [
        agentRow({ id: 1, name: 'Unset', modelTier: null }),
        agentRow({ id: 2, name: 'Top', modelTier: 'flagship' }),
        agentRow({ id: 3, name: 'Cheap', modelTier: 'light' }),
      ],
    });
    render(<AgentsAdminSection />);

    expect(await screen.findByText('Unclassified')).toBeInTheDocument();
    expect(screen.getByText('Flagship')).toBeInTheDocument();
    // Translated, not the raw enum: a Norwegian admin must not read "LIGHT" on
    // the row while the dropdown for the same value says "Lett".
    expect(screen.getByText('Light')).toBeInTheDocument();
    expect(screen.queryByText('light')).not.toBeInTheDocument();
  });

  it('labels a mid-tier badge through the same translation as the dropdown', async () => {
    fetchAdminAgents.mockResolvedValue({
      agents: [agentRow({ modelTier: 'mid' })],
    });
    render(<AgentsAdminSection />);

    expect(await screen.findByText('Mid')).toBeInTheDocument();
    expect(screen.queryByText('mid')).not.toBeInTheDocument();

    // And the dropdown option for that tier reads the same.
    const select = await openTierSelect();
    const option = Array.from(select.options).find((o) => o.value === 'mid');
    expect(option?.textContent).toBe('Mid');
  });

  it('describes flagship as one part of the quorum, not as sufficient alone', async () => {
    fetchAdminAgents.mockResolvedValue({ agents: [agentRow()] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AgentsAdminSection />);

    const select = await openTierSelect();
    fireEvent.change(select, { target: { value: 'flagship' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    // The high-risk rule requires the design-target quorum AND one flagship
    // approval (src/lib/assurance/policy.ts), so the prompt must not promise
    // that this identity alone publishes anything.
    const prompt = String(confirm.mock.calls[0]?.[0] ?? '');
    expect(prompt).toMatch(/two independent approvals/i);
    expect(prompt).not.toMatch(/alone/i);
  });

  it('saves a tier change through the admin API', async () => {
    fetchAdminAgents.mockResolvedValue({ agents: [agentRow()] });
    render(<AgentsAdminSection />);

    const select = await openTierSelect();
    fireEvent.change(select, { target: { value: 'mid' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(patchAgent).toHaveBeenCalled());
    const [id, payload] = firstPatch();
    expect(id).toBe(7);
    expect(payload).toMatchObject({ modelTier: 'mid' });
  });

  it('clears the tier back to unclassified with an explicit null', async () => {
    fetchAdminAgents.mockResolvedValue({
      agents: [agentRow({ modelTier: 'flagship' })],
    });
    render(<AgentsAdminSection />);

    const select = await openTierSelect();
    expect(select.value).toBe('flagship');
    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(patchAgent).toHaveBeenCalled());
    expect(firstPatch()[1]).toMatchObject({ modelTier: null });
  });

  it('leaves the tier out of the patch when it was not touched', async () => {
    fetchAdminAgents.mockResolvedValue({
      agents: [agentRow({ modelTier: 'mid' })],
    });
    render(<AgentsAdminSection />);

    fireEvent.click(await screen.findByText('Edit'));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(patchAgent).toHaveBeenCalled());
    expect(firstPatch()[1]).not.toHaveProperty('modelTier');
  });

  it('confirms before promoting to flagship, and sends nothing if declined', async () => {
    fetchAdminAgents.mockResolvedValue({ agents: [agentRow()] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AgentsAdminSection />);

    const select = await openTierSelect();
    fireEvent.change(select, { target: { value: 'flagship' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(patchAgent).not.toHaveBeenCalled();
  });

  it('confirms before creating a flagship agent, and creates nothing if declined', async () => {
    fetchAdminAgents.mockResolvedValue({ agents: [] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AgentsAdminSection />);
    await waitFor(() => expect(fetchAdminAgents).toHaveBeenCalled());

    const select = openCreateForm();
    fireEvent.change(select, { target: { value: 'flagship' } });
    fireEvent.submit(screen.getByText('Create agent').closest('form')!);

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('creates a flagship agent once the confirmation is accepted', async () => {
    fetchAdminAgents.mockResolvedValue({ agents: [] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AgentsAdminSection />);
    await waitFor(() => expect(fetchAdminAgents).toHaveBeenCalled());

    const select = openCreateForm();
    fireEvent.change(select, { target: { value: 'flagship' } });
    fireEvent.submit(screen.getByText('Create agent').closest('form')!);

    await waitFor(() => expect(createAgent).toHaveBeenCalled());
    expect(createAgent.mock.calls[0]?.[0]).toMatchObject({
      modelTier: 'flagship',
    });
  });

  it('does not confirm when creating a non-flagship agent', async () => {
    fetchAdminAgents.mockResolvedValue({ agents: [] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AgentsAdminSection />);
    await waitFor(() => expect(fetchAdminAgents).toHaveBeenCalled());

    const select = openCreateForm();
    fireEvent.change(select, { target: { value: 'mid' } });
    fireEvent.submit(screen.getByText('Create agent').closest('form')!);

    await waitFor(() => expect(createAgent).toHaveBeenCalled());
    expect(confirm).not.toHaveBeenCalled();
  });

  it('offers a tier this build no longer knows as its own option', async () => {
    fetchAdminAgents.mockResolvedValue({
      agents: [agentRow({ modelTier: 'legacy-tier' })],
    });
    render(<AgentsAdminSection />);

    const select = await openTierSelect();
    // Selected as stored, rather than silently displaying "Unclassified".
    expect(select.value).toBe('legacy-tier');
    const option = Array.from(select.options).find(
      (o) => o.value === 'legacy-tier',
    );
    expect(option?.textContent).toContain('unrecognised');
    // The row badge shows the raw value too, so the stored tier is legible
    // without opening the form.
    expect(screen.getAllByText(/legacy-tier/).length).toBeGreaterThan(1);
  });

  it('leaves an unrecognised stored tier alone when the form is not touched', async () => {
    fetchAdminAgents.mockResolvedValue({
      agents: [agentRow({ modelTier: 'legacy-tier' })],
    });
    render(<AgentsAdminSection />);

    fireEvent.click(await screen.findByText('Edit'));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(patchAgent).toHaveBeenCalled());
    expect(firstPatch()[1]).not.toHaveProperty('modelTier');
  });

  it('clears an unrecognised stored tier when Unclassified is chosen', async () => {
    fetchAdminAgents.mockResolvedValue({
      agents: [agentRow({ modelTier: 'legacy-tier' })],
    });
    render(<AgentsAdminSection />);

    const select = await openTierSelect();
    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(patchAgent).toHaveBeenCalled());
    expect(firstPatch()[1]).toMatchObject({ modelTier: null });
  });

  it('discards a cancelled tier change instead of reusing it on the next save', async () => {
    fetchAdminAgents.mockResolvedValue({
      agents: [agentRow({ modelTier: 'flagship' })],
    });
    render(<AgentsAdminSection />);

    // Start a demotion, then back out of it.
    const select = await openTierSelect();
    fireEvent.change(select, { target: { value: 'mid' } });
    fireEvent.click(screen.getAllByText('Cancel')[1]!); // the form's Cancel

    // Reopen: the form must show what is stored, not the abandoned draft.
    const reopened = await openTierSelect();
    expect(reopened.value).toBe('flagship');

    // And an unrelated save must not carry the cancelled demotion out with it.
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(patchAgent).toHaveBeenCalled());
    expect(firstPatch()[1]).not.toHaveProperty('modelTier');
  });

  it('discards other cancelled field edits too', async () => {
    fetchAdminAgents.mockResolvedValue({ agents: [agentRow()] });
    render(<AgentsAdminSection />);

    fireEvent.click(await screen.findByText('Edit'));
    const name = screen.getByPlaceholderText('Name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Renamed mid-thought' } });
    fireEvent.click(screen.getAllByText('Cancel')[0]!); // the row's Edit toggle

    fireEvent.click(screen.getByText('Edit'));
    expect(
      (screen.getByPlaceholderText('Name') as HTMLInputElement).value,
    ).toBe('Kinetix Agent');
  });

  it('does not confirm for a non-flagship tier', async () => {
    fetchAdminAgents.mockResolvedValue({ agents: [agentRow()] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AgentsAdminSection />);

    const select = await openTierSelect();
    fireEvent.change(select, { target: { value: 'light' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(patchAgent).toHaveBeenCalled());
    expect(confirm).not.toHaveBeenCalled();
  });
});
