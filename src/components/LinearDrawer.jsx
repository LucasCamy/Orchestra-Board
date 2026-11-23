import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, RefreshCw, Search, X } from 'lucide-react';
import useLinearIssues from '../hooks/useLinearIssues.js';
import useT from '../hooks/useT.js';
import { LinearFeedback, LinearIssueCard, extractLinearScopes, sortIssuesByHierarchy } from './LinearIssues.jsx';
import LinearLogo from './LinearLogo.jsx';

const DRAWER_STATUSES = ['inProgress', 'inReview', 'todo'];

export default function LinearDrawer({ onClose, onAdd, onSettings }) {
  const t = useT();
  const close = useRef(null);
  const { snapshot, error, loading, refresh } = useLinearIssues({ pendingOnly: true });
  const [query, setQuery] = useState('');
  const [scopeFilter, setScopeFilter] = useState('all');
  const [statusTab, setStatusTab] = useState('all');
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    const previous = document.activeElement;
    close.current.focus();
    return () => { if (document.activeElement === document.body) previous?.focus(); };
  }, []);

  const { projects, teams } = useMemo(() => extractLinearScopes(snapshot?.columns), [snapshot]);

  const filteredColumns = useMemo(() => {
    const q = query.trim().toLowerCase();
    const result = {};
    for (const status of DRAWER_STATUSES) {
      const list = (snapshot?.columns?.[status] ?? []).filter((issue) => {
        if (scopeFilter.startsWith('project:') && issue.projectId !== scopeFilter.slice(8)) return false;
        if (scopeFilter.startsWith('team:') && issue.teamId !== scopeFilter.slice(5)) return false;
        if (!q) return true;
        return issue.identifier.toLowerCase().includes(q) ||
          issue.title.toLowerCase().includes(q) ||
          (issue.parent?.identifier ?? '').toLowerCase().includes(q) ||
          (issue.projectName ?? '').toLowerCase().includes(q) ||
          (issue.assignee?.name ?? '').toLowerCase().includes(q);
      });
      result[status] = sortIssuesByHierarchy(list);
    }
    return result;
  }, [snapshot, query, scopeFilter]);

  const totalCount = DRAWER_STATUSES.reduce((sum, s) => sum + (filteredColumns[s]?.length ?? 0), 0);
  const visibleStatuses = statusTab === 'all' ? DRAWER_STATUSES : [statusTab];

  async function moveIssue(issue, nextStatus) {
    if (moving || issue.status === nextStatus) return;
    setMoving(true);
    try {
      const res = await window.linearBoard.updateIssueStatus({ issueId: issue.id, status: nextStatus, expectedStatus: issue.status });
      if (res?.error) refresh();
    } finally {
      setMoving(false);
    }
  }

  return <aside className="linear-drawer nowheel" aria-labelledby="linear-drawer-title" onKeyDown={(event) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
  }}>
    <header className="linear-drawer-header">
      <LinearLogo />
      <h2 id="linear-drawer-title">{t('linear.pending')}</h2>
      <button type="button" className="icon-button" title={t('linear.refresh')} aria-label={t('linear.refresh')} disabled={loading} onClick={refresh}><RefreshCw size={17} aria-hidden="true" /></button>
      <button type="button" className="icon-button" title={t('common.close')} aria-label={t('common.close')} ref={close} onClick={onClose}><X size={17} aria-hidden="true" /></button>
    </header>
    {snapshot && <div className="linear-drawer-controls">
      <div className="linear-drawer-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder="Buscar ID, título ou épico..."
          onChange={(e) => setQuery(e.target.value)}
        />
        {(projects.length > 1 || teams.length > 1) && (
          <select value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value)} aria-label={t('linear.filters')}>
            <option value="all">Todos</option>
            {projects.map((p) => <option key={`project:${p.id}`} value={`project:${p.id}`}>{p.name}</option>)}
            {teams.map((tm) => <option key={`team:${tm.id}`} value={`team:${tm.id}`}>{tm.name}</option>)}
          </select>
        )}
      </div>
      <div className="linear-drawer-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={statusTab === 'all'} className={`linear-tab${statusTab === 'all' ? ' active' : ''}`} onClick={() => setStatusTab('all')}>
          <span>Todos</span><span className="linear-tab-count">{totalCount}</span>
        </button>
        {DRAWER_STATUSES.map((status) => (
          <button key={status} type="button" role="tab" aria-selected={statusTab === status} className={`linear-tab${statusTab === status ? ' active' : ''}`} onClick={() => setStatusTab(status)}>
            <span>{t(`linear.${status}`)}</span>
            <span className="linear-tab-count">{filteredColumns[status]?.length ?? 0}</span>
          </button>
        ))}
      </div>
    </div>}
    <LinearFeedback error={error} loading={loading} snapshot={snapshot} onSettings={onSettings} />
    <div className="linear-drawer-list thin-scrollbar">
      {snapshot && totalCount === 0 && <p className="linear-empty">{t('linear.noIssues')}</p>}
      {snapshot && visibleStatuses.map((status) => {
        const items = filteredColumns[status] ?? [];
        if (!items.length) return null;
        return <details key={status} className="linear-drawer-group" data-linear-status={status} open>
          <summary className="linear-drawer-group-header">
            <span className="linear-status-mark" aria-hidden="true" />
            <span className="linear-drawer-group-title">{t(`linear.${status}`)}</span>
            <span className="linear-column-count">{items.length}</span>
          </summary>
          <div className="linear-drawer-group-cards">
            {items.map((issue) => <LinearIssueCard key={issue.id} issue={issue} onMove={moveIssue} busy={moving} />)}
          </div>
        </details>;
      })}
    </div>
    <footer className="linear-drawer-footer">
      <button type="button" className="text-button primary" style={{ width: '100%', justifyContent: 'center' }} onClick={onAdd}><Plus size={16} aria-hidden="true" />{t('linear.addBoard')}</button>
    </footer>
  </aside>;
}
