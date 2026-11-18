import { useEffect, useRef } from 'react';
import { Check, Star, TriangleAlert, X, Zap } from 'lucide-react';
import useT from '../hooks/useT.js';
import SessionTerminal from './SessionTerminal.jsx';

function SubagentStatus({ status }) {
  const t = useT();
  const label = t(status === 'working' ? 'card.subagents.running' : `card.subagents.${status}`);
  return (
    <span className={`subagent-status ${status}`} role="img" aria-label={label} title={label}>
      {status === 'completed' && <Check size={13} aria-hidden="true" />}
      {status === 'failed' && <TriangleAlert size={13} aria-hidden="true" />}
    </span>
  );
}

export function SubagentTabs({ subagents, active, onSelect, onClose, tabId, panelId }) {
  const t = useT();
  const mainTitle = t('card.subagents.main');
  const tabProps = (id) => ({
    id: tabId(id),
    type: 'button',
    role: 'tab',
    'aria-controls': panelId(id),
    'aria-selected': id === active,
    tabIndex: id === active ? 0 : -1,
    onClick: () => onSelect(id),
  });
  const navigate = (event) => {
    if (event.target.getAttribute('role') !== 'tab') return;
    const tabs = [null, ...subagents.map(({ id }) => id)];
    const index = tabs.indexOf(active);
    const targetIndex = {
      ArrowLeft: (index - 1 + tabs.length) % tabs.length,
      ArrowRight: (index + 1) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (targetIndex === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(tabs[targetIndex]);
    document.getElementById(tabId(tabs[targetIndex]))?.focus();
  };

  return (
    <div className="subagent-tabs nodrag nopan nowheel" role="tablist" aria-label={t('card.subagents.tabs')} onKeyDown={navigate}>
      <button className="subagent-tab subagent-main" {...tabProps(null)}>
        <Star size={13} aria-hidden="true" />
        {mainTitle}
      </button>
      <div className="subagent-scroll" role="presentation">
        {subagents.map(({ id, title, status }) => {
          const closeLabel = t('card.subagents.close', { title });
          return (
            <div key={id} className="subagent-tab-item" role="presentation">
              <button className="subagent-tab" {...tabProps(id)} title={title}>
                <Zap size={12} aria-hidden="true" />
                <span className="subagent-title">{title}</span>
                <SubagentStatus status={status} />
              </button>
              <button
                type="button"
                className="subagent-close"
                aria-label={closeLabel}
                title={closeLabel}
                onClick={() => {
                  if (subagents.length > 1) document.getElementById(tabId(active === id ? null : active))?.focus();
                  onClose(id);
                }}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SubagentDialog({ parentId, parentName, subagents, onClose, titleId }) {
  const t = useT();
  const dialog = useRef(null);
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);

  const pane = (id, title, status) => (
    <section key={id} className="subagent-pane">
      <div className="subagent-pane-header">
        <h2 title={title}>{title}</h2>
        {status && <SubagentStatus status={status} />}
      </div>
      <div className="terminal-body">
        <SessionTerminal id={id} label={title} readOnly />
      </div>
    </section>
  );

  return (
    <dialog
      className="dialog subagent-dialog"
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <header className="subagent-dialog-header">
        <h1 id={titleId}>{t('card.subagents.expand')}</h1>
        <button className="icon-button" aria-label={t('common.close')} title={t('common.close')} onClick={onClose} autoFocus>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="subagent-comparison">
        {pane(parentId, `${t('card.subagents.main')} · ${parentName}`)}
        <div className="subagent-comparison-children">
          {subagents.map(({ id, title, status }) => pane(id, title, status))}
        </div>
      </div>
    </dialog>
  );
}
