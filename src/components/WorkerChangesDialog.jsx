import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileDiff, Redo2, RefreshCw, Undo2, X } from 'lucide-react';
import useT from '../hooks/useT.js';

const LINE_CLASS = { '+': 'add', '-': 'del', '@': 'hunk', '\\': 'meta' };
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const validDraft = (text) => text.length <= MAX_TEXT_BYTES && text.isWellFormed() && !text.includes('\0') &&
  new TextEncoder().encode(text).length <= MAX_TEXT_BYTES;
const makeDraft = (text) => ({ text, valid: validDraft(text) });
const HISTORY_ACTIONS = [['undo', Undo2], ['redo', Redo2]];

function ConflictResolution({ index, conflict, choice, draft, setChoice, setDraft, chosen, toggle, disabled }) {
  const t = useT();
  const invalid = choice === 'manual' && !draft?.valid;
  const errorId = 'worker-conflict-error-' + index;
  return (
    <fieldset className="worker-conflict" disabled={disabled}>
      <legend>{t('workerChanges.resolveTitle')}</legend>
      <p className="hint">{t('workerChanges.conflict')}</p>
      <div className="worker-conflict-options">
        <label><input type="radio" name={`worker-conflict-${index}`} value="host" checked={choice === 'host'} onChange={() => setChoice('host')} />
          {t(conflict.hostExists ? 'workerChanges.keepHost' : 'workerChanges.keepHostDeletion')}</label>
        <label><input type="radio" name={`worker-conflict-${index}`} value="worker" checked={choice === 'worker'} onChange={() => setChoice('worker')} />
          {t(conflict.workerExists ? 'workerChanges.useWorker' : 'workerChanges.acceptWorkerDeletion')}</label>
        {conflict.text && <label><input type="radio" name={`worker-conflict-${index}`} value="manual" checked={choice === 'manual'} onChange={() => setChoice('manual')} />
          {t('workerChanges.editResolution')}</label>}
      </div>
      {conflict.text && <details className="worker-conflict-versions">
        <summary>{t('workerChanges.showVersions')}</summary>
        <div className="worker-conflict-columns">
          {[['host', 'workerChanges.destination'], ['worker', 'workerChanges.workerCopy']].map(([side, label]) => (
            <div key={side}>
              <strong>{t(label)}</strong>
              {conflict.text[side] === null ? <p className="hint">{t('workerChanges.fileAbsent')}</p> : (
                <>
                  <pre tabIndex={0} aria-label={t(label)}>{conflict.text[side] || t('workerChanges.emptyVersion')}</pre>
                  {choice === 'manual' && <button className="text-button" type="button" onClick={() => setDraft(conflict.text[side])}>
                    {t(side === 'host' ? 'workerChanges.startFromHost' : 'workerChanges.startFromWorker')}
                  </button>}
                </>
              )}
            </div>
          ))}
        </div>
      </details>}
      {choice === 'manual' && (
        <label className="field">
          <span>{t('workerChanges.result')}</span>
          <textarea className="worker-conflict-result" value={draft?.text ?? ''} rows={8} spellCheck={false}
            aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined} onChange={(event) => setDraft(event.target.value)} />
          {invalid && <span className="form-error" id={errorId} role="alert">{t('workerChanges.invalidDraft')}</span>}
        </label>
      )}
      <button className="text-button" type="button" disabled={!choice || invalid} onClick={toggle}>
        {t(chosen ? 'workerChanges.unselectResolution' : 'workerChanges.selectResolution')}
      </button>
    </fieldset>
  );
}

function ApplicationHistory({ batches, selection, onSelect, onPreview, confirmation, disabled, onReplay }) {
  const t = useT();
  return (
    <details className="worker-application-history">
      <summary>{t('workerChanges.history')}</summary>
      {batches.length === 0 ? <p className="hint">{t('workerChanges.historyEmpty')}</p> : (
        <>
          <ol className="worker-history-list thin-scrollbar">
            {batches.map(({ id, appliedAt, undo, redo, pathCount, paths }) => {
              const date = appliedAt === null ? null : new Date(appliedAt);
              const title = date?.toLocaleString(t.locale, { dateStyle: 'short', timeStyle: 'medium' }) ?? t('workerChanges.historyEarlier');
              const hidden = pathCount - paths.length;
              const files = [...paths, ...(hidden > 0 ? [t('workerChanges.historyMore', { n: hidden })] : [])].join(', ');
              const counts = [
                undo && t('workerChanges.historyApplied', { n: undo.count }),
                redo && t('workerChanges.historyUndone', { n: redo.count }),
              ].filter(Boolean).join(' · ');
              const actions = { undo, redo };
              return (
                <li className="worker-history-batch" key={id}>
                  <label className="worker-history-select">
                    <input type="checkbox" checked={selection.some((batch) => batch.id === id)} disabled={disabled}
                      aria-label={t('workerChanges.historySelectBatch', { date: title, files })}
                      onChange={(event) => onSelect(id, event.target.checked)} />
                  </label>
                  <div className="worker-history-description">
                    <strong>{date ? <time dateTime={date.toISOString()}>{title}</time> : title}</strong>
                    <span className="hint">{counts}</span>
                    <span className="worker-history-paths" title={files}>{files}</span>
                  </div>
                  <div className="worker-history-buttons">
                    {HISTORY_ACTIONS.map(([action, Icon]) => {
                      if (!actions[action]) return null;
                      const expanded = confirmation?.action === action && confirmation?.batchId === id;
                      return (
                        <button key={action} type="button" className={`text-button worker-batch-${action}`}
                          aria-label={t(`workerChanges.${action}BatchLabel`, { date: title, files })}
                          aria-expanded={expanded} aria-controls={expanded ? 'worker-history-confirmation' : undefined}
                          disabled={disabled} onClick={() => onReplay({ action, id: actions[action].id, batchId: id })}>
                          <Icon size={15} aria-hidden="true" />{t(`workerChanges.${action}Batch`)}
                        </button>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="worker-history-bulk">
            <p className="hint" role="status">{t(selection.length ? 'workerChanges.historySelected' : 'workerChanges.historySelectHint', { n: selection.length })}</p>
            <div className="worker-history-buttons">
              {HISTORY_ACTIONS.map(([action, Icon]) => (
                <button key={action} type="button" className={`text-button worker-history-preview-${action}`}
                  disabled={disabled || !selection.length || selection.some((batch) => !batch[action])}
                  onClick={(event) => onPreview(action, event.currentTarget)}>
                  <Icon size={15} aria-hidden="true" />{t(`workerChanges.historyPreview.${action}`)}
                </button>
              ))}
            </div>
          </div>
          {selection.length > 1 && HISTORY_ACTIONS.every(([action]) => selection.some((batch) => !batch[action])) &&
            <p className="hint">{t('workerChanges.historyMixedSelection')}</p>}
        </>
      )}
    </details>
  );
}

function DiffLines({ diff }) {
  return <pre className="changes-code">
    {diff.split('\n').map((line, index) => <div key={index} className={`changes-line ${LINE_CLASS[line[0]] ?? ''}`}>{line || ' '}</div>)}
  </pre>;
}

function DiffContent({ result, replay = false }) {
  const t = useT();
  if (!result) return <span className="hint" role="status">{t('changes.reading')}</span>;
  if (result.error) return <p className="form-error" role="alert">{result.error}{result.file && <> <code>{result.file}</code></>}</p>;
  const beforeHash = replay ? result.beforeHash : result.hostHash;
  const afterHash = replay ? result.afterHash : result.workerHash;
  return (
    <>
      {result.binary && <div className="worker-review-binary">
        <p className="hint">{t('changes.binary')}</p>
        {beforeHash && <p>{t(replay ? 'workerChanges.historyDiffBefore' : 'workerChanges.destination')} <code>{beforeHash}</code></p>}
        {afterHash && <p>{t(replay ? 'workerChanges.historyDiffAfter' : 'workerChanges.workerCopy')} <code>{afterHash}</code></p>}
      </div>}
      {result.modeChanged && <p className="hint">{t(replay ? 'workerChanges.historyDiffMode' : 'workerChanges.modeChanged')}</p>}
      {result.diff === '' && !result.modeChanged && <p className="hint">{t('workerChanges.emptyDiff')}</p>}
      {result.diff && <DiffLines diff={result.diff} />}
      {result.truncated && <p className="hint">{t(replay ? 'workerChanges.historyDiffTruncated' : 'workerChanges.truncated')}</p>}
    </>
  );
}

function ReplayInlinePart({ part, pending, onChange }) {
  const t = useT();
  const field = useRef(null);
  const [highlight, setHighlight] = useState(null);
  const { index, text, ranges, kind } = part;
  const label = t(kind === 'remove' ? 'workerChanges.historyInlineRemove' : 'workerChanges.historyInlineAdd', { n: index + 1 });
  const full = ranges.length === 1 && ranges[0].start === 0 && ranges[0].end === text.length;
  const partial = ranges.length > 0 && !full;
  useEffect(() => {
    const input = field.current;
    const select = () => {
      const { selectionStart: start, selectionEnd: end } = input;
      setHighlight(start < end ? { start, end } : null);
    };
    input.addEventListener('select', select);
    return () => input.removeEventListener('select', select);
  }, []);
  const addHighlight = () => {
    const ordered = [...(full ? [] : ranges), highlight].sort((a, b) => a.start - b.start);
    const merged = [];
    for (const { start, end } of ordered) {
      const previous = merged.at(-1);
      if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
      else merged.push({ start, end });
    }
    onChange(index, merged);
  };
  const alreadySelected = partial && highlight && ranges.some(({ start, end }) => start <= highlight.start && end >= highlight.end);
  return (
    <div className={`worker-replay-inline-part ${kind}`}>
      <input type="checkbox" checked={full} aria-label={label} aria-disabled={pending}
        ref={(input) => { if (input) input.indeterminate = partial; }}
        onChange={(event) => { if (!pending) onChange(index, event.target.checked ? [{ start: 0, end: text.length }] : []); }} />
      <code aria-hidden="true">{kind === 'remove' ? '−' : '+'}</code>
      <textarea ref={field} readOnly rows={1} wrap="off" value={text} aria-label={label} />
      <button type="button" className="text-button worker-replay-inline-use" disabled={pending || !highlight || alreadySelected}
        onClick={addHighlight}>{t(partial ? 'workerChanges.historyInlineExtend' : 'workerChanges.historyInlineUse')}</button>
      {partial && <ul className="worker-replay-inline-ranges">
        {ranges.map(({ start, end }, position) => (
          <li key={`${start}-${end}`}>
            <button type="button" className="text-button worker-replay-inline-range" disabled={pending}
              aria-label={t('workerChanges.historyInlineRemoveRange', { n: position + 1, fragment: index + 1 })}
              onClick={() => onChange(index, ranges.filter((_, i) => i !== position))}>
              <code>{text.slice(start, end)}</code>
              <X size={12} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>}
    </div>
  );
}

function ReplayInline({ boardId, target, id, file, line, pending, draft, onChange, onStale }) {
  const t = useT();
  const [loaded, setLoaded] = useState(null);
  useEffect(() => {
    if (pending) return undefined;
    let cancelled = false;
    window.workerChanges.replayInline(boardId, target, id, file, line).catch(() => ({ error: t('changes.failed') })).then((result) => {
      if (cancelled) return;
      if (result.stale) onStale(result);
      setLoaded({ id, result });
    });
    return () => { cancelled = true; };
  }, [boardId, target, id, file, line, pending, onStale, t]);
  const reviewing = pending || loaded?.id !== id;
  const original = loaded?.result.parts;
  const parts = draft && original ? original.map((part) => ({
    ...part, ranges: draft.filter(({ index }) => index === part.index).map(({ start, end }) => ({ start, end })),
  })) : original;
  const update = (index, selected) => {
    const ranges = parts.flatMap((part) => {
      const intervals = part.index === index ? selected : part.ranges;
      return intervals.map(({ start, end }) => ({ index: part.index, start, end }));
    });
    const baseline = original.flatMap((part) => part.ranges.map(({ start, end }) => ({ index: part.index, start, end })));
    const changed = ranges.length !== baseline.length || ranges.some(({ index, start, end }, i) => (
      index !== baseline[i].index || start !== baseline[i].start || end !== baseline[i].end
    ));
    onChange(line, ranges, changed);
  };
  return (
    <section className="worker-replay-inline" id="worker-replay-inline" aria-label={t('workerChanges.historyInlineOpen')}>
      <p className="hint">{t('workerChanges.historyInlineHint')}</p>
      {reviewing && <p className="hint" role="status">{t('changes.reading')}</p>}
      {loaded?.result.error && !reviewing && <p className="form-error" role="alert">{loaded.result.error}</p>}
      {parts?.map((part) => <ReplayInlinePart key={part.index} part={part} pending={reviewing} onChange={update} />)}
    </section>
  );
}

function ReplayHunkDiff({ result, pending, scopeLocked, drafts, onChange, onInlineChange, onStale, boardId, target, id, file }) {
  const t = useT();
  const [openedLine, setOpenedLine] = useState(null);
  const changes = result.hunks.flatMap(({ rows }) => rows.filter(({ index }) => index !== undefined));
  const selected = changes.filter(({ included }) => included).map(({ index }) => index);
  const toggle = (indexes, checked) => {
    if (pending || scopeLocked) return;
    const next = new Set(selected);
    for (const index of indexes) {
      if (checked) next.add(index);
      else next.delete(index);
    }
    onChange([...next], indexes);
  };
  return (
    <>
      {result.partial && !pending && <section className="worker-replay-projected" aria-label={t('workerChanges.historyDiffAfter')}>
        <h3>{t('workerChanges.historyDiffAfter')}</h3>
        <DiffContent result={result} replay />
      </section>}
      <p className="hint" role="status">{t(pending ? 'workerChanges.historyFilesUpdating' : 'workerChanges.historyLinesSelected',
        { n: selected.length, total: changes.length })}</p>
      <p className="hint">{t('workerChanges.historyLinesHint')}</p>
      {result.hunks.map(({ index, included, caption, rows }) => {
        const changed = rows.filter((row) => row.index !== undefined);
        const mixed = !included && changed.some((row) => row.included);
        return (
          <div className="worker-replay-hunk" key={index}>
            <label className="worker-replay-hunk-select">
              <input type="checkbox" checked={included} aria-disabled={pending}
                ref={(input) => { if (input) input.indeterminate = mixed; }}
                disabled={scopeLocked || (included && selected.length === changed.length)}
                aria-label={t('workerChanges.historyHunkSelect', { range: caption })}
                onChange={(event) => toggle(changed.map((row) => row.index), event.target.checked)} />
              <code>{caption}</code>
            </label>
            <div className="changes-code">
              {rows.map(({ text, index: lineIndex, number, included: lineIncluded, inline, partial }, rowIndex) => {
                const className = `changes-line worker-replay-line ${LINE_CLASS[text[0]] ?? ''}`;
                return lineIndex === undefined
                  ? <div className={className} key={rowIndex}><code>{text || ' '}</code></div>
                  : <div key={rowIndex}>
                    <div className={className}>
                      <label className="worker-replay-line-select">
                        <input type="checkbox" checked={lineIncluded && !partial} aria-disabled={pending}
                          ref={(input) => { if (input) input.indeterminate = partial; }}
                          disabled={scopeLocked || (lineIncluded && !partial && selected.length === 1)}
                          aria-label={t(text[0] === '+' ? 'workerChanges.historyLineAdd' : 'workerChanges.historyLineRemove', { n: number })}
                          onChange={(event) => toggle([lineIndex], event.target.checked)} />
                        <code>{text}</code>
                      </label>
                      {inline && <button type="button" className="text-button worker-replay-inline-open"
                        aria-label={t('workerChanges.historyInlineAtLine', { n: number })}
                        aria-expanded={openedLine === lineIndex} aria-controls={openedLine === lineIndex ? 'worker-replay-inline' : undefined}
                        disabled={pending} onClick={() => setOpenedLine(openedLine === lineIndex ? null : lineIndex)}>
                        {t(drafts?.has(lineIndex) ? 'workerChanges.historyInlineDraft' : 'workerChanges.historyInlineOpen')}
                      </button>}
                    </div>
                    {openedLine === lineIndex && <ReplayInline key={lineIndex} boardId={boardId} target={target} id={id}
                      file={file} line={lineIndex} pending={pending} draft={drafts?.get(lineIndex)} onChange={onInlineChange} onStale={onStale} />}
                  </div>;
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}

function ReplayConflicts({ conflict, review, editable, pending, draft, setDraft, onResolve, batch, t }) {
  const active = review?.regions ?? [];
  const details = active.length ? active : conflict.details;
  const fileSelected = active.length > 0 && active.every(({ key }) => batch?.choices.has(key));
  return (
    <details className="worker-replay-conflicts">
      <summary>{t('workerChanges.historySelectionConflicts', { n: active.length || conflict.count })}</summary>
      {!review && <p className="hint" role="status">{t('workerChanges.historyConflictLoading')}</p>}
      {review?.error && <p className="form-error" role="alert">{review.error}</p>}
      {batch && active.length > 0 && <button type="button" className="text-button worker-replay-conflict-select-file"
        disabled={!editable || Boolean(draft)} onClick={() => batch.onSelect(active.map(({ key }) => key), !fileSelected)}>
        {t(fileSelected ? 'workerChanges.historyConflictClearFile' : 'workerChanges.historyConflictSelectFile')}
      </button>}
      <ol>
        {details.map(({ key, line, local, selected, choice, content }, index) => {
          const staged = batch?.choices.get(key);
          const manual = staged?.strategy === 'manual' ? staged : !batch && key && draft?.key === key ? draft : null;
          const invalid = Boolean(manual && !manual.valid);
          const activeChoice = staged?.strategy ?? (batch?.choices.has(key) ? null : choice);
          const titleId = key && `worker-replay-conflict-${key}`;
          const errorId = titleId && `${titleId}-error`;
          const setManual = (text) => {
            if (batch) batch.onStage(key, { strategy: 'manual', ...makeDraft(text) });
            else setDraft({ key, ...makeDraft(text) });
          };
          const choose = (strategy) => {
            if (strategy === 'manual') {
              const text = staged?.text ?? (activeChoice === 'local' ? local : activeChoice === 'selected' ? selected :
                content ?? (choice === 'selected' ? selected : local));
              setManual(text);
            } else if (batch) batch.onStage(key, { strategy });
            else onResolve(key, strategy);
          };
          return <li key={key ?? index}>
            <span className="hint" id={titleId}>{t('workerChanges.historyConflictReviewedLine', { line })}</span>
            {key && batch && <label className="worker-replay-conflict-checkbox">
              <input type="checkbox" checked={batch.choices.has(key)} aria-describedby={titleId} disabled={!editable || Boolean(draft)}
                onChange={(event) => batch.onSelect([key], event.target.checked)} />
              {t('workerChanges.historyConflictSelectRegion')}
            </label>}
            <dl>
              <dt>{t('workerChanges.historyConflictLocal')}</dt>
              <dd><code>{local || t('workerChanges.historyConflictEmpty')}</code></dd>
              <dt>{t('workerChanges.historyConflictSelected')}</dt>
              <dd><code>{selected || t('workerChanges.historyConflictEmpty')}</code></dd>
              {choice === 'manual' && <>
                <dt>{t('workerChanges.historyConflictManualText')}</dt>
                <dd><code>{content || t('workerChanges.historyConflictEmpty')}</code></dd>
              </>}
            </dl>
            {key && <div className="worker-replay-conflict-actions" role="group" aria-labelledby={titleId}>
              <button type="button" className="text-button" aria-pressed={activeChoice === 'local' && !manual} disabled={!editable || Boolean(draft)}
                onClick={() => choose('local')}>{t('workerChanges.historyConflictKeep')}</button>
              <button type="button" className="text-button" aria-pressed={activeChoice === 'selected' && !manual} disabled={!editable || Boolean(draft)}
                onClick={() => choose('selected')}>{t('workerChanges.historyConflictApply')}</button>
              <button type="button" className="text-button" aria-pressed={activeChoice === 'manual' || Boolean(manual)} disabled={!editable || Boolean(draft)}
                onClick={() => choose('manual')}>
                {t('workerChanges.editResolution')}
              </button>
            </div>}
            {manual && <div className="worker-replay-conflict-editor">
              <label className="field">
                <span>{t('workerChanges.historyConflictManualText')}</span>
                <textarea autoFocus={!batch} className="worker-conflict-result" value={manual.text} rows={4} spellCheck={false}
                  disabled={!editable} aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined}
                  onChange={(event) => setManual(event.target.value)} />
                {invalid && <span id={errorId} className="form-error" role="alert">{t('workerChanges.invalidDraft')}</span>}
              </label>
              {!batch && <div className="worker-replay-conflict-actions">
                <button type="button" className="text-button" disabled={!editable || invalid} onClick={() => onResolve(key, 'manual', manual.text)}>
                  {t('workerChanges.historyConflictRecalculate')}
                </button>
                <button type="button" className="text-button" disabled={pending} onClick={() => setDraft(null)}>{t('common.cancel')}</button>
              </div>}
            </div>}
          </li>;
        })}
      </ol>
      {!active.length && conflict.count > conflict.details.length && <p className="hint">
        {t('workerChanges.historyConflictMore', { n: conflict.count - conflict.details.length })}
      </p>}
      {review?.regions?.length === 0 && <p className="hint">{t('workerChanges.historyConflictHistorical')}</p>}
    </details>
  );
}

function ReplayPreview({ boardId, target, targetPath, preview, onCancel, onConfirm }) {
  const t = useT();
  const api = window.workerChanges;
  const { action } = preview;
  const originalFiles = useMemo(() => new Set(preview.files.filter(({ effect }) => effect).map(({ path }) => path)), [preview.files]);
  const [revision, setRevision] = useState(() => ({ ...preview, included: originalFiles }));
  const [pendingSelection, setPendingSelection] = useState(null);
  const [selectionError, setSelectionError] = useState(null);
  const [selectionNotice, setSelectionNotice] = useState(null);
  const [opened, setOpened] = useState(null);
  const [loaded, setLoaded] = useState(null);
  const [conflictLoaded, setConflictLoaded] = useState(null);
  const [manualDraft, setManualDraft] = useState(null);
  const [conflictBatch, setConflictBatch] = useState(false);
  const [batchChoices, setBatchChoices] = useState(() => new Map());
  const [inlineBatch, setInlineBatch] = useState(false);
  const [inlineDrafts, setInlineDrafts] = useState(() => new Map());
  const selectionRequest = useRef(false);
  const { id, files, ready, selected, included, lines, rebasedFiles, selectionConflicts, resolvableConflicts, unavailableFiles } = revision;
  const unavailable = useMemo(() => new Set(unavailableFiles), [unavailableFiles]);
  const allFiles = useMemo(() => new Set([...originalFiles].filter((file) => !unavailable.has(file))), [originalFiles, unavailable]);
  const projected = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const lineSelection = useMemo(() => new Map(lines.map((file) => [file.path, file])), [lines]);
  const conflictsByPath = useMemo(() => new Map(selectionConflicts.map((file) => [file.path, file])), [selectionConflicts]);
  const conflictKeysByPath = useMemo(() => new Map(resolvableConflicts.map(({ path, keys }) => [path, keys])), [resolvableConflicts]);
  const batchItems = [...conflictKeysByPath].flatMap(([file, keys]) => keys.filter((key) => batchChoices.has(key)).map((key) => ({ file, key })));
  const batchFileCount = new Set(batchItems.map(({ file }) => file)).size;
  const batchHasChoices = batchItems.some(({ key }) => batchChoices.get(key));
  const batchReadyCount = batchItems.filter(({ key }) => {
    const choice = batchChoices.get(key);
    return choice && (choice.strategy !== 'manual' || choice.valid);
  }).length;
  const rows = useMemo(() => preview.files.toSorted((a, b) => a.path.localeCompare(b.path, t.locale)), [preview.files, t.locale]);
  const updating = pendingSelection !== null;
  const chosen = pendingSelection ?? included;
  const openEffect = projected.get(opened)?.effect;
  const openConflict = conflictsByPath.get(opened);
  const conflictReview = conflictLoaded?.path === opened ? conflictLoaded.value : null;
  const showDiff = Boolean(openEffect && openEffect !== 'history');
  const lastResult = loaded?.path === opened ? loaded.result : null;
  const result = loaded?.id === id ? lastResult : null;
  const selectionStale = Boolean(selectionError?.stale);
  const stale = Boolean(result?.stale || selectionStale);
  const staged = [...inlineDrafts.values()].reduce((count, lines) => count + lines.size, 0);

  useEffect(() => {
    if (!showDiff || updating || selectionStale) return undefined;
    let cancelled = false;
    api.replayDiff(boardId, target, id, opened).catch(() => ({ error: t('changes.failed') })).then((value) => {
      if (!cancelled) setLoaded({ id, path: opened, result: value });
    });
    return () => { cancelled = true; };
  }, [api, boardId, target, id, opened, showDiff, updating, selectionStale, t]);

  useEffect(() => {
    if (!openConflict || updating || selectionStale) return undefined;
    let cancelled = false;
    api.replayConflicts(boardId, target, id, opened).catch(() => ({ error: t('changes.failed') })).then((value) => {
      if (cancelled) return;
      setConflictLoaded({ path: opened, id, value });
      if (value.stale) setSelectionError(value);
    });
    return () => { cancelled = true; };
  }, [api, boardId, target, id, opened, openConflict, updating, selectionStale, t]);

  const revisePreview = async (paths, request, refreshing = false) => {
    if (selectionRequest.current || (stale && !refreshing)) return null;
    selectionRequest.current = true;
    setPendingSelection(paths);
    if (!refreshing) setSelectionError(null);
    setSelectionNotice(null);
    const next = await request().catch(() => ({ error: t('changes.failed') }));
    if (next.error) setSelectionError(refreshing ? { ...next, stale: true } : next);
    else {
      setSelectionError(null);
      setRevision({ ...next, included: next.included ? new Set(next.included) : paths });
      setBatchChoices((choices) => {
        if (!choices.size) return choices;
        const active = new Set(next.resolvableConflicts.flatMap(({ keys }) => keys));
        return new Map([...choices].filter(([key]) => active.has(key)));
      });
    }
    setPendingSelection(null);
    selectionRequest.current = false;
    return next.error ? null : next;
  };
  const retainInlineDrafts = (files, includedInPreview = []) => {
    const paths = new Set(files);
    const kept = new Map([...inlineDrafts].filter(([file]) => paths.has(file)));
    const removed = [...inlineDrafts.keys()].filter((file) => !paths.has(file) && !includedInPreview.includes(file)).length;
    setInlineDrafts(kept);
    return removed;
  };
  const updateSelection = async (paths) => {
    const next = await revisePreview(paths, () => api.updateReplayPreview(boardId, target, id, [...paths]));
    if (!next) return;
    const removed = retainInlineDrafts(next.retained);
    if (removed) setSelectionNotice(t('workerChanges.historyDraftFilesRemoved', { n: removed }));
  };
  const refreshPreview = async () => {
    const drafts = [...inlineDrafts].flatMap(([file, lines]) => [...lines].map(([line, ranges]) => ({ file, line, ranges })));
    const next = await revisePreview(included, () => api.refreshReplayPreview(boardId, target, id, drafts), true);
    if (!next) return;
    const manualRemoved = manualDraft && !next.conflictKeys.includes(manualDraft.key);
    if (manualRemoved) setManualDraft(null);
    const active = new Set(next.resolvableConflicts.flatMap(({ keys }) => keys));
    const batchDraftsRemoved = [...batchChoices].some(([key, choice]) => choice && !active.has(key));
    const removed = retainInlineDrafts(next.retained, [...next.recovered, ...next.conflicts]);
    const notices = [
      t('workerChanges.historyPreviewRefreshed'),
      removed && t('workerChanges.historyDraftFilesRemoved', { n: removed }),
      manualRemoved && t('workerChanges.historyConflictDraftRemoved'),
      batchDraftsRemoved && t('workerChanges.historyConflictBatchDraftRemoved'),
      next.omitted.length && t('workerChanges.historyRefreshOmitted', { n: next.omitted.length }),
      next.recovered.length && t('workerChanges.historyRefreshRecovered', { n: next.recovered.length }),
      next.selectionConflicts.length && t('workerChanges.historyRefreshSelectionConflicts'),
      next.conflicts.length && t('workerChanges.historyRefreshConflicts', { n: next.conflicts.length }),
      next.limited && t('workerChanges.historyRefreshLimited', { n: next.limited }),
    ];
    setSelectionNotice(notices.filter(Boolean).join(' '));
  };
  const resolveConflict = async (key, strategy, content) => {
    const item = { file: opened, key, strategy, content };
    const next = await revisePreview(included, () => api.resolveReplayConflict(boardId, target, id, item));
    if (next && strategy === 'manual') setManualDraft(null);
  };
  const selectConflictKeys = (keys, checked) => {
    setBatchChoices((previous) => {
      const next = new Map(previous);
      for (const key of keys) {
        if (!checked) next.delete(key);
        else if (!next.has(key)) next.set(key, null);
      }
      return next;
    });
  };
  const stageConflictChoice = (key, choice) => {
    setBatchChoices((previous) => new Map(previous).set(key, choice));
  };
  const resolveConflictBatch = async (strategy) => {
    const batch = strategy ? { strategy, items: batchItems } : { items: batchItems.map(({ file, key }) => {
      const choice = batchChoices.get(key);
      return { file, key, strategy: choice.strategy, ...(choice.strategy === 'manual' && { content: choice.text }) };
    }) };
    const next = await revisePreview(included,
      () => api.resolveReplayConflictBatch(boardId, target, id, batch));
    if (!next) return;
    setBatchChoices(new Map());
    setSelectionNotice(t('workerChanges.historyConflictBatchResolved', { n: batchItems.length, files: batchFileCount }));
  };
  const updateLines = (indexes, reset) => revisePreview(included, () => api.updateReplayLines(boardId, target, id, opened, indexes, reset));
  const updateInline = (line, ranges, changed) => {
    if (!inlineBatch) {
      if (changed) revisePreview(included, () => api.updateReplayInline(boardId, target, id, opened, line, ranges));
      return;
    }
    setSelectionError(null);
    setInlineDrafts((previous) => {
      const next = new Map(previous);
      const lines = new Map(next.get(opened));
      if (changed) lines.set(line, ranges);
      else lines.delete(line);
      if (lines.size) next.set(opened, lines);
      else next.delete(opened);
      return next;
    });
  };
  const recalculateInline = async () => {
    const selections = [...inlineDrafts].flatMap(([file, lines]) => [...lines].map(([line, ranges]) => ({ file, line, ranges })));
    if (await revisePreview(included, () => api.updateReplayInlineBatch(boardId, target, id, selections))) {
      setInlineDrafts(new Map());
    }
  };
  const discardInline = () => {
    setInlineDrafts(new Map());
    if (!selectionStale) setSelectionError(null);
  };
  const confirm = async () => {
    if (selectionRequest.current) return;
    selectionRequest.current = true;
    setPendingSelection(included);
    setSelectionNotice(null);
    const result = await onConfirm(id);
    if (result.error) setSelectionError({ ...result, stale: true });
    setPendingSelection(null);
    selectionRequest.current = false;
  };

  const toggleFile = (path, checked) => {
    const paths = new Set(included);
    if (checked) paths.add(path);
    else paths.delete(path);
    updateSelection(paths);
  };

  return (
    <section className="worker-history-confirmation worker-history-preview" aria-labelledby="worker-replay-title">
      <h2 id="worker-replay-title">{t(`workerChanges.historyPreview.${action}`)}</h2>
      {targetPath && <p className="hint worker-replay-destination">{t('workerChanges.destination')} <code>{targetPath}</code></p>}
      <p className="hint worker-replay-summary">{t('workerChanges.historyPreviewSummary', { ready, selected })}</p>
      {!opened && files.some(({ effect }) => effect && effect !== 'history') &&
        <p className="hint worker-replay-summary">{t('workerChanges.historyDiffHint')}</p>}
      {allFiles.size > 0 && <div className="worker-replay-selection">
        <p className="hint" role="status">{t(updating ? 'workerChanges.historyFilesUpdating' : 'workerChanges.historyFilesSelected',
          { n: chosen.size, total: allFiles.size })}</p>
        <div className="worker-history-buttons">
          <button type="button" className="text-button worker-replay-select-all" disabled={updating || stale || chosen.size === allFiles.size}
            onClick={() => updateSelection(allFiles)}>{t('workerChanges.historyFilesSelectAll')}</button>
          <button type="button" className="text-button worker-replay-clear" disabled={updating || stale || chosen.size === 0}
            onClick={() => updateSelection(new Set())}>{t('workerChanges.historyFilesClear')}</button>
        </div>
      </div>}
      {allFiles.size > 0 && <div className="worker-replay-selection worker-replay-inline-batch">
        <label>
          <input className="worker-replay-inline-batch-toggle" type="checkbox" checked={inlineBatch}
            disabled={updating || stale || staged > 0} onChange={(event) => setInlineBatch(event.target.checked)} />
          {t('workerChanges.historyInlineBatch')}
        </label>
        {inlineBatch && <div className="worker-history-buttons">
          <button type="button" className="text-button worker-replay-inline-recalculate" disabled={!staged || updating || stale}
            onClick={recalculateInline}>{t('workerChanges.historyInlineRecalculate')}</button>
          <button type="button" className="text-button worker-replay-inline-discard" disabled={!staged || updating}
            onClick={discardInline}>{t('workerChanges.historyInlineDiscard')}</button>
        </div>}
      </div>}
      {inlineBatch && <p className="hint worker-replay-summary worker-replay-inline-batch-status" role="status">
        {staged ? t('workerChanges.historyInlineBatchStaged', { n: staged, files: inlineDrafts.size }) : t('workerChanges.historyInlineBatchHint')}
      </p>}
      {resolvableConflicts.length > 0 && <div className="worker-replay-selection worker-replay-conflict-batch">
        <label className="worker-replay-conflict-checkbox">
          <input className="worker-replay-conflict-batch-toggle" type="checkbox" checked={conflictBatch}
            disabled={updating || stale || Boolean(manualDraft) || batchItems.length > 0}
            onChange={(event) => setConflictBatch(event.target.checked)} />
          {t('workerChanges.historyConflictBatch')}
        </label>
        {conflictBatch && <>
          <p className="hint worker-replay-conflict-batch-status" role="status">
            {t(batchItems.length ? 'workerChanges.historyConflictBatchCount' : 'workerChanges.historyConflictBatchHint',
              { n: batchItems.length, files: batchFileCount })}
            {batchHasChoices && <> · {t('workerChanges.historyConflictBatchReady', { n: batchReadyCount, total: batchItems.length })}</>}
          </p>
          <div className="worker-history-buttons">
            <button type="button" className="text-button worker-replay-conflict-batch-select-all"
              disabled={updating || stale || Boolean(manualDraft) || resolvableConflicts.every(({ keys }) => keys.every((key) => batchChoices.has(key)))}
              onClick={() => selectConflictKeys(resolvableConflicts.flatMap(({ keys }) => keys), true)}>
              {t('workerChanges.historyConflictBatchAll')}
            </button>
            <button type="button" className="text-button worker-replay-conflict-batch-clear" disabled={updating || !batchItems.length}
              onClick={() => setBatchChoices(new Map())}>{t('workerChanges.historyConflictBatchClear')}</button>
            <button type="button" className="text-button worker-replay-conflict-batch-local"
              disabled={updating || stale || Boolean(manualDraft) || !batchItems.length || batchHasChoices}
              onClick={() => resolveConflictBatch('local')}>{t('workerChanges.historyConflictBatchLocal')}</button>
            <button type="button" className="text-button worker-replay-conflict-batch-selected"
              disabled={updating || stale || Boolean(manualDraft) || !batchItems.length || batchHasChoices}
              onClick={() => resolveConflictBatch('selected')}>{t('workerChanges.historyConflictBatchSelected')}</button>
            <button type="button" className="text-button worker-replay-conflict-batch-recalculate"
              disabled={updating || stale || Boolean(manualDraft) || !batchItems.length || batchReadyCount !== batchItems.length}
              onClick={() => resolveConflictBatch()}>{t('workerChanges.historyConflictRecalculate')}</button>
          </div>
        </>}
      </div>}
      {selectionError && <p className="form-error worker-replay-summary" role="alert">
        {selectionError.error}{selectionError.file && <> <code>{selectionError.file}</code></>}
      </p>}
      {selectionNotice && <p className="hint worker-replay-summary" role="status">{selectionNotice}</p>}
      {manualDraft && <p className="hint worker-replay-summary" role="status">{t('workerChanges.historyConflictDraftPending', { path: manualDraft.path })}</p>}
      <div className={`worker-replay-body${opened ? ' has-diff' : ''}`}>
        <ul className="worker-replay-files thin-scrollbar" tabIndex={0} aria-label={t('workerChanges.historyPreviewFiles')}>
          {rows.map((row, index) => {
            const { path } = row;
            const selectable = allFiles.has(path);
            const excluded = selectable && !chosen.has(path);
            const { effect, skipped } = projected.get(path) ?? row;
            const partial = lineSelection.get(path);
            const conflict = conflictsByPath.get(path);
            const selectedConflicts = conflictKeysByPath.get(path)?.filter((key) => batchChoices.has(key)).length;
            const hasDiff = selectable && !excluded && effect && effect !== 'history';
            const effectStatus = [
              effect && t(`workerChanges.historyEffect.${effect}`), skipped && t(`workerChanges.historySkipped.${skipped}`),
              partial && t('workerChanges.historyLinesSelected', { n: partial.selected, total: partial.total }),
              partial?.textSelections && t('workerChanges.historyInlineSelected', { n: partial.textSelections }),
              rebasedFiles.includes(path) && t('workerChanges.historyRecoveredSelection'),
              inlineDrafts.has(path) && t('workerChanges.historyInlineDraftFile'),
            ].filter(Boolean).join(' · ');
            const status = [unavailable.has(path) ? t('workerChanges.historyFileUnavailable') :
              excluded ? t('workerChanges.historyFileExcluded') : effectStatus,
              conflict && t('workerChanges.historySelectionConflicts', { n: conflict.count }),
              selectedConflicts > 0 && t('workerChanges.historyConflictFileCount', { n: selectedConflicts }),
            ].filter(Boolean).join(' · ');
            const statusId = 'worker-replay-effect-' + index;
            const details = <>
              <code>{path}</code>
              <span className="hint" id={statusId}>{status}</span>
            </>;
            const isOpen = opened === path;
            return (
              <li key={path}>
                {selectable && <label className="worker-replay-file-select">
                  <input type="checkbox" checked={!excluded} disabled={stale || updating}
                    aria-label={t('workerChanges.historyFileSelect', { path })} aria-describedby={statusId}
                    onChange={(event) => toggleFile(path, event.target.checked)} />
                </label>}
                {(conflict || hasDiff) ? (
                  <button type="button" className={`changes-file worker-replay-open-diff${isOpen ? ' active' : ''}`}
                    aria-label={t(hasDiff ? 'workerChanges.historyDiffOpen' : 'workerChanges.historyConflictOpen', { path })}
                    aria-describedby={statusId}
                    aria-expanded={isOpen} aria-controls={isOpen ? 'worker-replay-diff' : undefined} disabled={updating || stale}
                    onClick={() => { setLoaded(null); setOpened(isOpen ? null : path); }}>
                    <FileDiff size={15} aria-hidden="true" />{details}
                  </button>
                ) : <div className="worker-replay-file-status">{details}</div>}
              </li>
            );
          })}
        </ul>
        {opened && <div key={opened} id="worker-replay-diff" className="changes-diff worker-replay-diff thin-scrollbar" tabIndex={0}
          role="region" aria-label={t(openConflict && !showDiff ? 'workerChanges.historyConflictOpen' : 'workerChanges.historyDiffOpen', { path: opened })}>
          <header>
            <strong><code>{opened}</code></strong>
            {showDiff && !updating && <p className="hint">{t('workerChanges.historyDiffComparison')}</p>}
          </header>
          {openConflict && <ReplayConflicts conflict={openConflict} review={conflictReview} pending={updating} t={t}
            editable={conflictLoaded?.id === id && !updating && !stale && (included.has(opened) || unavailable.has(opened))}
            draft={manualDraft?.path === opened ? manualDraft : manualDraft && {}}
            batch={conflictBatch && conflictKeysByPath.has(opened)
              ? { choices: batchChoices, onSelect: selectConflictKeys, onStage: stageConflictChoice } : null}
            setDraft={(draft) => setManualDraft(draft && { ...draft, path: opened })} onResolve={resolveConflict} />}
          {lastResult?.hunks && showDiff ? <ReplayHunkDiff key={opened} result={lastResult} pending={updating || !result || stale}
            scopeLocked={inlineDrafts.has(opened)} drafts={inlineDrafts.get(opened)}
            onChange={updateLines} onInlineChange={updateInline} onStale={setSelectionError}
            boardId={boardId} target={target} id={id} file={opened} /> :
            updating || showDiff ? <DiffContent result={updating ? null : result} replay /> : (
            <p className="hint">{t(unavailable.has(opened) ? 'workerChanges.historyFileUnavailable' : included.has(opened)
              ? openEffect ? 'workerChanges.historyEffect.history' : 'workerChanges.historySkipped.changed' : 'workerChanges.historyFileExcluded')}</p>
          )}
        </div>}
      </div>
      <div className="dialog-actions">
        <button autoFocus type="button" className="text-button" disabled={updating} onClick={onCancel}>{t('common.cancel')}</button>
        {stale && <button type="button" className="text-button worker-replay-refresh" disabled={updating} onClick={refreshPreview}>
          {t('workerChanges.historyRefreshPreview')}
        </button>}
        <button type="button" className="text-button primary worker-history-confirm-group"
          disabled={ready === 0 || updating || staged > 0 || batchItems.length > 0 || Boolean(manualDraft) || Boolean(selectionError) || stale || (showDiff && !result)}
          onClick={confirm}>
          {t(`workerChanges.historyConfirm.${action}`)}
        </button>
      </div>
    </section>
  );
}

export default function WorkerChangesDialog({ boardId, onClose }) {
  const t = useT();
  const api = window.workerChanges;
  const [targets, setTargets] = useState(null);
  const [target, setTarget] = useState('');
  const [review, setReview] = useState(null);
  const [active, setActive] = useState(null);
  const [previewState, setPreview] = useState(null);
  const [seen, setSeen] = useState({});
  const [chosen, setChosen] = useState([]);
  const [choices, setChoices] = useState({});
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [historyInfo, setHistoryInfo] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [selectedBatches, setSelectedBatches] = useState([]);
  const [groupPreview, setGroupPreview] = useState(null);
  const groupTrigger = useRef(null);
  const reviewRequest = useRef(0);
  const historyRequest = useRef(0);
  const busy = operation !== null;
  const history = historyInfo?.target === target
    ? { undo: historyInfo.lastApplication, redo: historyInfo.lastUndoneApplication, batches: historyInfo.batches }
    : {};
  const pendingBatch = confirmation?.batchId && history.batches?.find(({ id }) => id === confirmation.batchId);
  const pending = confirmation && (confirmation.batchId ? pendingBatch : history)?.[confirmation.action];
  const confirming = pending?.id === confirmation?.id && Boolean(pending);
  const historyLocked = busy || confirming || groupPreview !== null;
  const batchSelection = history.batches?.filter(({ id }) => selectedBatches.includes(id)) ?? [];
  const closeGroupPreview = useCallback(() => {
    setGroupPreview(null);
    requestAnimationFrame(() => groupTrigger.current?.focus());
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.targets(boardId).catch(() => ({ error: t('changes.failed') })).then((result) => {
      if (cancelled) return;
      setTargets(result);
      setTarget(result.targets?.[0]?.id ?? '');
    });
    return () => { cancelled = true; };
  }, [api, boardId, t]);

  const load = useCallback(async (targetId) => {
    const request = ++reviewRequest.current;
    setLoading(true);
    setReview(null);
    setActive(null);
    setPreview(null);
    setSeen({});
    setChosen([]);
    setChoices({});
    const result = await api.review(boardId, targetId).catch(() => ({ error: t('changes.failed') }));
    if (request !== reviewRequest.current) return;
    setReview(result);
    setActive(result.files?.[0]?.index ?? null);
    setLoading(false);
  }, [api, boardId, t]);

  useEffect(() => { if (target) load(target); }, [target, load]);

  const loadHistory = useCallback(async (targetId) => {
    const request = ++historyRequest.current;
    const result = await api.undoStatus(boardId, targetId).catch(() => ({ error: t('changes.failed') }));
    if (request === historyRequest.current) setHistoryInfo({ target: targetId, ...result });
  }, [api, boardId, t]);

  useEffect(() => {
    setConfirmation(null);
    setSelectedBatches([]);
    setGroupPreview(null);
    if (target) loadHistory(target);
    return () => { historyRequest.current++; };
  }, [target, loadHistory]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || busy) return;
      if (groupPreview) closeGroupPreview();
      else if (confirming) setConfirmation(null);
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, confirming, groupPreview, closeGroupPreview, onClose]);

  useEffect(() => {
    setPreview(null);
    if (!review?.id || active === null) return;
    let cancelled = false;
    api.diff(boardId, target, review.id, active).catch(() => ({ error: t('changes.failed') })).then((result) => {
      if (cancelled) return;
      setPreview({ reviewId: review.id, index: active, result });
      if (!result.error) setSeen((previous) => ({ ...previous, [active]: true }));
    });
    return () => { cancelled = true; };
  }, [api, boardId, target, review, active, t]);

  const files = review?.files ?? [];
  const opened = files.find(({ index }) => index === active);
  const preview = previewState?.reviewId === review?.id && previewState?.index === active ? previewState.result : null;
  const draftKey = (path) => `${target}\0${path}`;
  const draft = opened ? drafts[draftKey(opened.path)] : null;
  const canSelect = ({ index, blocked, path }) => {
    if (!seen[index] || blocked === 'unsupported') return false;
    if (!blocked) return true;
    return Boolean(choices[index] && (choices[index] !== 'manual' || drafts[draftKey(path)]?.valid));
  };
  const toggle = (index, value) => setChosen((previous) => {
    if (!value) return previous.filter((item) => item !== index);
    return previous.includes(index) ? previous : [...previous, index];
  });
  const selectStrategy = (strategy) => {
    toggle(active, false);
    setChoices((previous) => ({ ...previous, [active]: strategy }));
    if (strategy !== 'manual') return;
    const key = draftKey(opened.path);
    const { host, worker } = preview.conflict.text;
    setDrafts((previous) => Object.hasOwn(previous, key) ? previous : { ...previous, [key]: makeDraft(host ?? worker ?? '') });
  };

  const apply = async () => {
    const selection = files.filter(({ index }) => chosen.includes(index));
    const payload = selection.map((file) => {
      const { index, blocked } = file;
      if (!blocked) return index;
      const strategy = choices[index];
      return { index, strategy, ...(strategy === 'manual' && { content: drafts[draftKey(file.path)].text }) };
    });
    setOperation('apply');
    setFeedback(null);
    const result = await api.apply(boardId, target, review.id, payload).catch(() => ({ error: t('changes.failed') }));
    setFeedback(result);
    if (!result.error) {
      setDrafts((previous) => {
        const next = { ...previous };
        for (const file of selection) delete next[draftKey(file.path)];
        return next;
      });
      await Promise.all([load(target), loadHistory(target)]);
    }
    setOperation(null);
  };

  const replayBatch = async () => {
    const { action, id, batchId } = confirmation;
    setOperation(action);
    setConfirmation(null);
    setFeedback(null);
    const result = await api[action](boardId, target, id, batchId).catch(() => ({ error: t('changes.failed') }));
    setFeedback({ ...result, action });
    if (!result.error && (result.restored || result.reopened || result.reapplied || result.resolved)) load(target);
    await loadHistory(target);
    setOperation(null);
  };

  const toggleBatch = (id, checked) => setSelectedBatches((previous) =>
    checked ? [...previous, id] : previous.filter((item) => item !== id));

  const previewGroup = async (action, trigger) => {
    const selection = batchSelection.map((batch) => ({ batchId: batch.id, id: batch[action].id }));
    groupTrigger.current = trigger;
    setOperation('preview');
    setFeedback(null);
    const result = await api.previewReplay(boardId, target, action, selection).catch(() => ({ error: t('changes.failed') }));
    if (result.error) {
      setFeedback(result);
      await loadHistory(target);
    } else setGroupPreview({ ...result, action });
    setOperation(null);
  };

  const replayGroup = async (id) => {
    const { action } = groupPreview;
    setOperation(action);
    setFeedback(null);
    const result = await api.confirmReplay(boardId, target, id).catch(() => ({ error: t('changes.failed') }));
    if (!result.error) {
      setGroupPreview(null);
      setFeedback({ ...result, action });
      setSelectedBatches([]);
      if (result.batches) load(target);
    }
    await loadHistory(target);
    setOperation(null);
    return result;
  };

  const refresh = () => {
    setConfirmation(null);
    setGroupPreview(null);
    setFeedback(null);
    load(target);
    loadHistory(target);
  };

  const count = chosen.length;
  const deletions = files.filter(({ index, status, blocked }) => chosen.includes(index) && status === 'D' &&
    (!blocked || choices[index] === 'worker')).length;
  const ready = count > 0 && files.filter(({ index }) => chosen.includes(index)).every(canSelect);
  const targetPath = targets?.targets?.find(({ id }) => id === target)?.source;
  const close = () => { if (!busy) onClose(); };

  return createPortal(
    <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="modal changes-modal worker-review-modal" role="dialog" aria-modal="true" aria-labelledby="worker-changes-title">
        <header className="modal-header">
          <h1 id="worker-changes-title">{t('workerChanges.title')}</h1>
          <span className="changes-actions">
            {HISTORY_ACTIONS.map(([action, Icon]) => {
              if (!history[action]) return null;
              const expanded = confirming && !confirmation.batchId && confirmation.action === action;
              const label = t(`workerChanges.${operation === action ? action + 'ing' : action}`);
              return (
                <button key={action} className={`text-button worker-history-action worker-review-${action}`} type="button"
                  aria-label={label} title={label} aria-expanded={expanded} aria-controls={expanded ? 'worker-history-confirmation' : undefined}
                  disabled={historyLocked} onClick={() => setConfirmation({ action, id: history[action].id })}>
                  <Icon size={15} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              );
            })}
            <button className={`icon-button ${loading ? 'spinning' : ''}`} aria-label={t('changes.refresh')} title={t('changes.refresh')} disabled={loading || busy || !target}
              onClick={refresh}>
              <RefreshCw size={15} />
            </button>
            <button autoFocus className="icon-button" onClick={close} disabled={busy} aria-label={t('common.close')} title={t('common.close')}><X size={17} /></button>
          </span>
        </header>
        <div className="changes-scope" hidden={Boolean(groupPreview)}>
          {targets?.targets?.length > 1 ? (
            <label className="field"><span>{t('workerChanges.destination')}</span>
              <select value={target} disabled={loading || historyLocked} onChange={(event) => { setFeedback(null); setTarget(event.target.value); }}>
                {targets.targets.map(({ id, source }) => <option key={id} value={id}>{source}</option>)}
              </select>
            </label>
          ) : targetPath && <><strong>{t('workerChanges.destination')}</strong><span className="hint">{targetPath}</span></>}
          <p className="hint">{t('workerChanges.instructions')}</p>
          {review?.legacy && <p className="hint">{t('workerChanges.legacy')}</p>}
          {review?.limited && <p className="hint">{t('changes.filesLimited')}</p>}
          {history.batches && <ApplicationHistory key={target} batches={history.batches}
            confirmation={confirming ? confirmation : null} disabled={historyLocked} onReplay={setConfirmation}
            selection={batchSelection} onSelect={toggleBatch} onPreview={previewGroup} />}
          {operation === 'preview' && <p className="hint" role="status">{t('changes.reading')}</p>}
          {confirming && <div className="worker-history-confirmation" id="worker-history-confirmation">
            <p>{t(`workerChanges.${confirmation.action}Confirm${pending.count === 1 ? 'One' : ''}`, { n: pending.count })}</p>
            <div className="dialog-actions">
              <button autoFocus className="text-button" type="button" onClick={() => setConfirmation(null)}>{t('common.cancel')}</button>
              <button className={`text-button primary worker-${confirmation.action}-confirm`} type="button" onClick={replayBatch}>
                {t(`workerChanges.${confirmation.action}Batch`)}
              </button>
            </div>
          </div>}
          {historyInfo?.target === target && historyInfo.error && <p className="hint" role="status">{historyInfo.error}</p>}
          {feedback && (
            <div className="worker-review-feedback" role={feedback.error ? 'alert' : 'status'}>
              <p className={feedback.error ? 'form-error' : 'worker-review-success'}>
                {feedback.error ?? [
                  feedback.batches && t(`workerChanges.historyCompleted.${feedback.action}`, { n: feedback.batches }),
                  feedback.applied && t(feedback.applied === 1 ? 'workerChanges.appliedOne' : 'workerChanges.applied', { n: feedback.applied }),
                  feedback.resolved && t(`workerChanges.${feedback.action === 'redo' ? 'redoResolutions' : 'resolved'}${feedback.resolved === 1 ? 'One' : ''}`, { n: feedback.resolved }),
                  feedback.restored && t(feedback.restored === 1 ? 'workerChanges.undoRestoredOne' : 'workerChanges.undoRestored', { n: feedback.restored }),
                  feedback.reopened && t(feedback.reopened === 1 ? 'workerChanges.undoReopenedOne' : 'workerChanges.undoReopened', { n: feedback.reopened }),
                  feedback.reapplied && t(feedback.reapplied === 1 ? 'workerChanges.redoReappliedOne' : 'workerChanges.redoReapplied', { n: feedback.reapplied }),
                ].filter(Boolean).join(' ')}{feedback.file && <> <code>{feedback.file}</code></>}
              </p>
              {feedback.skipped?.length > 0 && <>
                <p>{t(`workerChanges.${feedback.action}Skipped`)}</p>
                <ul className={`worker-history-skipped worker-${feedback.action}-skipped thin-scrollbar`}>{feedback.skipped.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
              </>}
            </div>
          )}
        </div>
        {groupPreview && <ReplayPreview key={groupPreview.id} boardId={boardId} target={target} targetPath={targetPath}
          preview={groupPreview} onCancel={closeGroupPreview} onConfirm={replayGroup} />}
        {!groupPreview && (targets?.error || review?.error) && <p className="changes-message" role="alert">{targets?.error ?? review.error}</p>}
        {!groupPreview && targets?.targets?.length === 0 && <p className="changes-message">{t('workerChanges.noDestination')}</p>}
        {!groupPreview && (!targets || loading) && <p className="changes-message hint" role="status">{t('changes.reading')}</p>}
        {!groupPreview && review?.files?.length === 0 && <p className="changes-message">{t('workerChanges.none')}</p>}
        {!groupPreview && files.length > 0 && (
          <>
            <div className="changes-body">
              <ul className="changes-files thin-scrollbar">
                {files.map((file) => {
                  const { index, path, status, blocked } = file;
                  return (
                    <li className="worker-review-row" key={index}>
                      <input type="checkbox"
                        aria-label={t('workerChanges.select', { path })}
                        title={t(!blocked || choices[index] ? 'workerChanges.select' : 'workerChanges.' + blocked, { path })}
                        disabled={busy || !canSelect(file)}
                        checked={chosen.includes(index)}
                        onChange={(event) => toggle(index, event.target.checked)}
                      />
                      <button className={`changes-file ${active === index ? 'active' : ''}`} aria-current={active === index ? 'true' : undefined}
                        disabled={busy} title={path} onClick={() => setActive(index)}>
                        <span className={`changes-status s-${status}`} aria-label={t('workerChanges.status.' + status)}>{status}</span>
                        <span className="changes-path"><span className="changes-name">{path}</span></span>
                        {blocked && <span className="worker-review-flag">
                          {t(choices[index] ? 'workerChanges.resolutionChosen' : 'workerChanges.short.' + blocked)}
                        </span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="changes-diff thin-scrollbar" aria-label={opened?.path}>
                {preview?.conflict && <ConflictResolution
                  index={active} conflict={preview.conflict} choice={choices[active]} draft={draft}
                  setChoice={selectStrategy} setDraft={(text) => setDrafts((previous) => ({ ...previous, [draftKey(opened.path)]: makeDraft(text) }))}
                  chosen={chosen.includes(active)} toggle={() => toggle(active, !chosen.includes(active))}
                  disabled={busy}
                />}
                <DiffContent result={preview} />
              </div>
            </div>
            <footer className="dialog-actions worker-review-footer">
              <span className="hint" role="status">{t('workerChanges.selected', { n: count })}{deletions ? ` · ${t('workerChanges.deletions', { n: deletions })}` : ''}</span>
              <button className="text-button primary" disabled={!ready || count > 200 || loading || historyLocked} onClick={apply}>
                {t(operation === 'apply' ? 'workerChanges.applying' : 'workerChanges.apply')}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
