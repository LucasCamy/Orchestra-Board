import { useEffect, useRef } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import useLinearIssues from '../hooks/useLinearIssues.js';
import useT from '../hooks/useT.js';
import { LinearFeedback, LinearIssueCard } from './LinearIssues.jsx';
import LinearLogo from './LinearLogo.jsx';

export default function LinearDrawer({ onClose, onAdd, onSettings }) {
  const t = useT();
  const close = useRef(null);
  const { snapshot, error, loading, refresh } = useLinearIssues({ pendingOnly: true });
  useEffect(() => {
    const previous = document.activeElement;
    close.current.focus();
    return () => { if (document.activeElement === document.body) previous?.focus(); };
  }, []);
  const issues = snapshot ? Object.values(snapshot.columns).flat() : [];
  return <aside className="linear-drawer nowheel" aria-labelledby="linear-drawer-title" onKeyDown={(event) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
  }}>
    <header className="linear-drawer-header">
      <LinearLogo />
      <h2 id="linear-drawer-title">{t('linear.pending')}</h2>
      <button type="button" className="icon-button" title={t('linear.refresh')} aria-label={t('linear.refresh')} disabled={loading} onClick={refresh}><RefreshCw size={17} aria-hidden="true" /></button>
      <button type="button" className="icon-button" title={t('common.close')} aria-label={t('common.close')} ref={close} onClick={onClose}><X size={17} aria-hidden="true" /></button>
    </header>
    <LinearFeedback error={error} loading={loading} snapshot={snapshot} onSettings={onSettings} />
    <div className="linear-drawer-list thin-scrollbar">
      {snapshot && !issues.length && <p className="linear-empty">{t('linear.noIssues')}</p>}
      {issues.map((issue) => <LinearIssueCard key={issue.id} issue={issue} />)}
    </div>
    <footer className="linear-drawer-footer">
      <button type="button" className="text-button" onClick={onAdd}><Plus size={16} aria-hidden="true" />{t('linear.addBoard')}</button>
    </footer>
  </aside>;
}
