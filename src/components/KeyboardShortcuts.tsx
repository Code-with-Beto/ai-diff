import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Keyboard, X } from 'lucide-react';
import { areSingleKeyShortcutsEnabled, isEditingTarget, modifierLabel, setSingleKeyShortcutsEnabled, subscribeToSingleKeyShortcuts } from '../lib/shortcuts';

export default function KeyboardShortcuts() {
  const [open, setOpen] = useState(false);
  const singleKeyEnabled = useSyncExternalStore(subscribeToSingleKeyShortcuts, areSingleKeyShortcutsEnabled, () => true);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!areSingleKeyShortcutsEnabled() || event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing || event.defaultPrevented || isEditingTarget(event.target) || document.querySelector('dialog[open]')) return;
      event.preventDefault(); setOpen(true);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [open]);

  return <>
    <button className="icon-button" onClick={() => setOpen(true)} aria-label="Keyboard shortcuts" aria-haspopup="dialog" aria-keyshortcuts={singleKeyEnabled ? 'Shift+/' : undefined} title={singleKeyEnabled ? 'Keyboard shortcuts (?)' : 'Keyboard shortcuts'}><Keyboard size={18} aria-hidden="true" /></button>
    {open && <dialog ref={dialog} className="shortcuts-dialog" aria-labelledby="shortcuts-title" onCancel={event => { event.preventDefault(); setOpen(false); }} onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className="shortcuts-heading"><h2 id="shortcuts-title">Keyboard shortcuts</h2><button className="icon-button" aria-label="Close shortcuts" onClick={() => setOpen(false)}><X size={18} aria-hidden="true" /></button></div>
      <label className="shortcuts-preference"><input type="checkbox" checked={singleKeyEnabled} onChange={event => setSingleKeyShortcutsEnabled(event.target.checked)} /><span>Enable single-key shortcuts<small>T, /, and ? · this page only</small></span></label>
      <dl>
        <div><dt>Toggle theme</dt><dd><kbd>T</kbd></dd></div>
        <div><dt>Find a repository</dt><dd><kbd>/</kbd></dd></div>
        <div><dt>Analyze selected repositories</dt><dd><kbd>{modifierLabel} ↵</kbd></dd></div>
        <div><dt>Share result</dt><dd><kbd>{modifierLabel} ⇧ S</kbd></dd></div>
        <div><dt>Copy image in share dialog</dt><dd><kbd>{modifierLabel} ⇧ C</kbd></dd></div>
        <div><dt>Close dialog</dt><dd><kbd>Esc</kbd></dd></div>
        <div><dt>Show shortcuts</dt><dd><kbd>?</kbd></dd></div>
      </dl>
    </dialog>}
  </>;
}
