import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentHookRunsPanel } from './AgentHookRunsPanel';
import { fetchAgentHookRuns, type AgentHookRun } from '@/lib/agentsApi';

vi.mock('@/lib/agentsApi', () => ({
  fetchAgentHookRuns: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'admin.hookRuns.pageStatus') {
        return `Page ${options?.page} of ${options?.pages}`;
      }
      if (key === 'admin.hookRuns.rangeStatus') {
        return `Showing ${options?.from}-${options?.to} of ${options?.total}`;
      }
      return typeof options?.defaultValue === 'string'
        ? options.defaultValue
        : key;
    },
  }),
}));

const fetchAgentHookRunsMock = vi.mocked(fetchAgentHookRuns);

function makeRun(id: number): AgentHookRun {
  return {
    id,
    event: 'comment_posted',
    targetType: 'drug_discussion',
    targetId: id,
    outcome: 'success',
    httpStatus: 200,
    errorMessage: `run-${id}`,
    durationMs: 100 + id,
    createdAt: `2026-05-${String(id).padStart(2, '0')}T00:00:00.000Z`,
  };
}

describe('AgentHookRunsPanel', () => {
  beforeEach(() => {
    fetchAgentHookRunsMock.mockReset();
  });

  it('paginates hook runs at 10 entries per page', async () => {
    fetchAgentHookRunsMock.mockResolvedValue({
      runs: Array.from({ length: 12 }, (_, index) => makeRun(index + 1)),
    });

    render(<AgentHookRunsPanel />);

    await waitFor(() => {
      expect(screen.getByText('run-1')).toBeInTheDocument();
    });
    expect(screen.getByText('run-10')).toBeInTheDocument();
    expect(screen.queryByText('run-11')).toBeNull();
    expect(screen.getByText('Showing 1-10 of 12')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.queryByText('run-1')).toBeNull();
    expect(screen.getByText('run-11')).toBeInTheDocument();
    expect(screen.getByText('run-12')).toBeInTheDocument();
    expect(screen.getByText('Showing 11-12 of 12')).toBeInTheDocument();
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  });
});
