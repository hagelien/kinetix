export type AgentFocusMode = 'all' | 'pages' | 'parameters' | 'methods';

export interface AgentFocusPage {
  id: number;
  title: string;
  slug: string;
  pageType: string;
}

export interface AgentFocusMethod {
  id: number;
  code: string;
  name: string;
  /** Resolved component drug ids belonging to this method. */
  drugIds: number[];
}

export interface AgentFocusConfig {
  mode: AgentFocusMode;
  pageIds: number[];
  parameters: string[];
  methodIds: number[];
  /**
   * EFFECTIVE: agents author no monograph facts or wiki sections while this is
   * on. True under `mode = 'parameters'`, which closes that action on its own,
   * whether or not the switch below is set.
   */
  skipWikiContent: boolean;
  /**
   * STORED: the switch as the admin left it, with no mode override folded in.
   * The form binds to this one, so a mode switch cannot make it write back a
   * `false` it inferred rather than one an admin chose.
   */
  skipWikiContentSetting: boolean;
  updatedAt: string | null;
  pages: AgentFocusPage[];
  methods: AgentFocusMethod[];
}

export interface WikiSearchResult {
  id: number;
  slug: string;
  title: string;
  pageType: string;
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export async function fetchAgentFocusConfig(): Promise<AgentFocusConfig> {
  const { config } = await apiFetch<{ config: AgentFocusConfig }>(
    '/api/agent-focus',
  );
  return config;
}

export async function updateAgentFocusConfig(data: {
  mode: AgentFocusMode;
  pageIds?: number[];
  parameters?: string[];
  methodIds?: number[];
  /** Omitted leaves the stored value alone; the server never reads it as off. */
  skipWikiContent?: boolean;
}): Promise<AgentFocusConfig> {
  const { config } = await apiFetch<{ config: AgentFocusConfig }>(
    '/api/agent-focus',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    },
  );
  return config;
}

/** Typeahead for adding pages/monographs to the focus list. */
export async function searchWikiPages(q: string): Promise<WikiSearchResult[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const { results } = await apiFetch<{ results: WikiSearchResult[] }>(
    `/api/wiki/search?q=${encodeURIComponent(trimmed)}&limit=8`,
  );
  return results;
}
