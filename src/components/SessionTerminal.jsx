import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useSettings } from '../context/SettingsContext.jsx';
import useTerminalZoomFix from '../hooks/useTerminalZoomFix.js';
import { terminalFont, terminalTheme } from '../lib/terminalTheme.js';

// Attach to an existing PTY. The comparison view never sends input or resizes the session.
export default function SessionTerminal({ id, label, readOnly = false }) {
  const mount = useRef(null);
  const terminal = useRef(null);
  const { theme, accent, terminalFontSize } = useSettings().settings.appearance;
  useTerminalZoomFix(mount);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: terminalFont(),
      fontSize: terminalFontSize,
      theme: terminalTheme(),
      cursorBlink: !readOnly,
      disableStdin: readOnly,
    });
    const fit = readOnly ? null : new FitAddon();
    if (fit) term.loadAddon(fit);
    term.open(mount.current);

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return true;
      const key = event.key.toLowerCase();
      if (key === 'c' && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        if (!event.shiftKey) term.clearSelection();
        event.preventDefault();
        return false;
      }
      return key !== 'v';
    });
    let replaying = false;
    const input = readOnly ? null : term.onData((data) => { if (!replaying) window.pty.write(id, data); });
    let offset = 0;
    let pending = [];
    let disposed = false;
    const write = (data, end, onParsed) => {
      if (end <= offset) return;
      term.write(data.slice(Math.max(0, offset - (end - data.length))), onParsed);
      offset = end;
    };
    const off = window.pty.onData(id, (data, end) => {
      if (pending) pending.push([data, end]);
      else write(data, end);
    });
    const load = (snapshot) => {
      if (disposed) return;
      if (snapshot) {
        // Preserve VT cursor positions when replaying a TUI in a narrower comparison pane.
        if (readOnly) term.resize(snapshot.cols, snapshot.rows);
        if (snapshot.offset > offset) {
          replaying = true;
          write(snapshot.buffer, snapshot.offset, () => { replaying = false; });
        }
      }
      for (const [data, end] of pending) write(data, end);
      pending = null;
    };
    window.pty.snapshot(id).then(load, () => load(null));

    const resize = () => {
      if (!fit) return;
      fit.fit();
      window.pty.resize(id, term.cols, term.rows);
    };
    terminal.current = { term, resize };
    resize();
    const observer = fit ? new ResizeObserver(resize) : null;
    observer?.observe(mount.current);
    return () => {
      disposed = true;
      observer?.disconnect();
      off();
      input?.dispose();
      term.dispose();
      terminal.current = null;
    };
  }, [id, readOnly]);

  useEffect(() => {
    const session = terminal.current;
    if (!session) return;
    session.term.options.theme = terminalTheme();
    if (session.term.options.fontSize !== terminalFontSize) {
      session.term.options.fontSize = terminalFontSize;
      session.resize();
    }
  }, [id, readOnly, theme, accent, terminalFontSize]);

  return <div className="terminal-mount" ref={mount} role="group" aria-label={label} />;
}
