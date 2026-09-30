/**
 * React binding for the Lab guideline table.
 *
 * Both readers of the table — the detection-times page's own section and the
 * substance register's column — go through this hook, so the access check, the
 * fetch and the name index are decided in one place. The check happens client
 * side purely to avoid a request that would be refused; the route is the
 * authority, and it answers a gated caller with an empty table regardless of
 * what the client believed.
 */
import { useEffect, useMemo, useState } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { canAccessLabDetectionTimes } from './featureAccess';
import {
  EMPTY_LAB_PAYLOAD,
  fetchLabDetectionTimes,
  labNameIndexFor,
} from './labDetectionApi';
import {
  matchLabRows,
  substanceNameCandidates,
  type LabRowMatch,
  type LabUrineDetectionPayload,
} from './labDetectionTimes';

export interface LabDetectionAccess {
  /** True when this reader is entitled to the guideline at all. */
  canAccess: boolean;
  payload: LabUrineDetectionPayload;
  /** True while the first request for this identity is open. */
  loading: boolean;
  /** The guideline rows a substance is named in, by its Kinetix names. */
  matchFor: (substance: {
    names?: Record<string, string> | null;
    nameShort?: string | null;
    aliases?: string[] | null;
  }) => LabRowMatch[];
}

export function useLabDetectionTimes(): LabDetectionAccess {
  const user = useAuthStore((state) => state.user);
  const overrides = useAuthStore((state) => state.permissionOverrides);
  const canAccess = canAccessLabDetectionTimes(user, overrides);
  // Identity, not entitlement, keys the cache: two users may both be entitled
  // and must still not share a fetch.
  const identity = user?.id ?? null;

  const [payload, setPayload] =
    useState<LabUrineDetectionPayload>(EMPTY_LAB_PAYLOAD);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!canAccess) {
      setPayload(EMPTY_LAB_PAYLOAD);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchLabDetectionTimes(identity).then((result) => {
      if (cancelled) return;
      setPayload(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [canAccess, identity]);

  const index = useMemo(() => labNameIndexFor(payload.rows), [payload.rows]);

  const matchFor = useMemo(
    () =>
      (substance: {
        names?: Record<string, string> | null;
        nameShort?: string | null;
        aliases?: string[] | null;
      }) =>
        payload.rows.length === 0
          ? []
          : matchLabRows(index, substanceNameCandidates(substance)),
    [index, payload.rows.length],
  );

  return { canAccess, payload, loading, matchFor };
}
