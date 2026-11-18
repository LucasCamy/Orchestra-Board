import { useEffect, useState } from 'react';
import useT from '../hooks/useT.js';

export default function LinearConnection() {
  const t = useT();
  const [configured, setConfigured] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    window.linearBoard?.connection().then((result) => {
      if (live) setConfigured(result.configured);
    }).catch(() => { if (live) setError('keyStorage'); });
    return () => { live = false; };
  }, []);

  async function save(value) {
    setBusy(true);
    setError(null);
    try {
      const result = await window.linearBoard.saveKey(value);
      if (result.error) setError(result.error);
      else {
        setConfigured(result.configured);
        setKey('');
      }
    } catch { setError('keyStorage'); }
    finally { setBusy(false); }
  }

  return (
    <form className="field" onSubmit={(event) => { event.preventDefault(); void save(key.trim()); }}>
      <label className="field">
        <span className="field-label">{t('linear.apiKey')}</span>
        <input type="password" className="linear-key-input" autoComplete="off" spellCheck={false} value={key} maxLength={256} onChange={(event) => setKey(event.target.value)} />
      </label>
      <span className="hint">{t(configured ? 'linear.keyConfigured' : 'linear.keyHint')}</span>
      {error && <span className="hint" role="alert">{t(`linear.error.${error}`)}</span>}
      <div className="field-row">
        <button type="submit" className="text-button" disabled={!key.trim() || busy}>{t('linear.saveKey')}</button>
        {configured && <button type="button" className="text-button" disabled={busy} onClick={() => save('')}>{t('linear.removeKey')}</button>}
      </div>
    </form>
  );
}
