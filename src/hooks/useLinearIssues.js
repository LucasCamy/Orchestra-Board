import { useCallback, useEffect, useRef, useState } from 'react';
import { LINEAR_STATUSES } from '../../electron/linearModel.mjs';

const POLL_INTERVAL = 60_000;

function applyIssue(snapshot, issue, projectId, teamId, pendingOnly) {
  if (!snapshot) return snapshot;
  const matches = (!projectId || issue.projectId === projectId) && (!teamId || issue.teamId === teamId) && (!pendingOnly || issue.status !== 'done');
  if (!matches && !LINEAR_STATUSES.some((status) => snapshot.columns[status].some((card) => card.id === issue.id))) return snapshot;
  const columns = Object.fromEntries(LINEAR_STATUSES.map((status) => [status, snapshot.columns[status].filter((card) => card.id !== issue.id)]));
  if (matches && issue.status) columns[issue.status].unshift(issue);
  return { ...snapshot, columns };
}

export default function useLinearIssues({ projectId, teamId, pendingOnly } = {}) {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const refreshRef = useRef(null);
  const refresh = useCallback(() => refreshRef.current?.(true), []);

  useEffect(() => {
    const api = window.linearBoard;
    if (!api) { setLoading(false); setError('unavailable'); return; }
    let disposed = false;
    let inFlight = false;
    let refreshAgain = false;
    let version = 0;
    let debounce = null;
    let needsKey = false;

    async function fetchIssues(showLoading = false) {
      if (disposed) return;
      if (showLoading) setLoading(true);
      if (inFlight) { refreshAgain = true; return; }
      inFlight = true;
      const started = version;
      try {
        const result = await api.fetchIssues({ projectId, teamId, pendingOnly });
        if (disposed || started !== version) return;
        needsKey = result.error === 'notConfigured';
        setError(result.error ?? null);
        if (!result.error) setSnapshot(result);
      } catch {
        if (!disposed && started === version) setError('unavailable');
      } finally {
        inFlight = false;
        if (!disposed && refreshAgain) {
          refreshAgain = false;
          void fetchIssues();
        } else if (!disposed) setLoading(false);
      }
    }

    refreshRef.current = fetchIssues;
    const unsubscribe = api.onIssueChanged(({ issue, connectionChanged }) => {
      version++;
      if (connectionChanged) {
        setSnapshot(null);
        setError(null);
        void fetchIssues(true);
      } else if (issue) {
        setSnapshot((current) => applyIssue(current, issue, projectId, teamId, pendingOnly));
        if (inFlight) refreshAgain = true;
      } else if (!needsKey && debounce === null) {
        debounce = setTimeout(() => { debounce = null; void fetchIssues(); }, 160);
      }
    });
    void fetchIssues(true);
    // Reconcile changes from clients that cannot report PostToolUse to Orchestra.
    const poll = setInterval(() => { if (!needsKey && !document.hidden) void fetchIssues(); }, POLL_INTERVAL);
    return () => {
      disposed = true;
      refreshRef.current = null;
      unsubscribe();
      clearTimeout(debounce);
      clearInterval(poll);
    };
  }, [projectId, teamId, pendingOnly]);

  return { snapshot, error, loading, refresh };
}
