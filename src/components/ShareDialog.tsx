import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, LoaderCircle, X } from 'lucide-react';
import type { ShareResult } from '../../shared/types';
import { copyShareImage, createShareText, createShareUrl, downloadShareImage, renderShareImage, type ShareImageTheme } from '../lib/share';
import { getTheme } from '../lib/theme';
import './ShareDialog.css';

export default function ShareDialog({ result, close }: { result: ShareResult; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const [blob, setBlob] = useState<Blob | null>(null), [url, setUrl] = useState(''), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [copying, setCopying] = useState(false);
  const [imageTheme, setImageTheme] = useState<ShareImageTheme>(getTheme);
  const needsConsent = result.includesPrivate && !result.sample;
  const [consent, setConsent] = useState(!needsConsent);
  const shareUrl = createShareUrl(result);
  const shareText = createShareText(result);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => {
      element?.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => { setConsent(!needsConsent); }, [result, needsConsent]);

  useEffect(() => {
    const run = ++generation.current;
    let imageUrl = '';
    setBlob(null); setUrl(''); setNotice(''); setError(''); setCopying(false);
    renderShareImage(result, imageTheme).then(value => {
      if (generation.current !== run) return;
      setBlob(value); imageUrl = URL.createObjectURL(value); setUrl(imageUrl);
    }).catch(() => { if (generation.current === run) setError('The image could not be created. Close this panel and try again.'); });
    return () => {
      generation.current += 1;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [result, imageTheme]);

  function changeImageTheme(theme: ShareImageTheme) {
    if (theme === imageTheme || copying) return;
    // Disable export immediately, before a previous render or copy can finish.
    generation.current += 1;
    setBlob(null); setUrl(''); setNotice(''); setError('');
    setImageTheme(theme);
  }

  const copyImage = useCallback(async () => {
    if (!consent) { setError('Confirm that you’re comfortable sharing private totals first.'); return; }
    if (!blob) { setNotice('Your image is still preparing. Try the shortcut again in a moment.'); return; }
    if (copying) return;
    const run = generation.current;
    setCopying(true);
    try {
      await copyShareImage(blob);
      if (generation.current === run) { setNotice('Image copied. Paste it anywhere.'); setError(''); }
    } catch {
      if (generation.current === run) setError('Your browser could not copy the image. Download the PNG instead.');
    } finally { if (generation.current === run) setCopying(false); }
  }, [blob, consent, copying]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault(); void copyImage();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [copyImage]);

  async function copyLink() {
    if (!consent) return;
    const run = generation.current;
    try {
      await navigator.clipboard.writeText(shareUrl);
      if (generation.current === run) { setNotice('Result link copied. Anyone with it can see these totals.'); setError(''); }
    } catch {
      if (generation.current === run) setError('Clipboard access was blocked. Expand Result link below to select and copy it.');
    }
  }

  async function copyText() {
    if (!consent) return;
    const run = generation.current;
    setNotice('');
    try {
      await navigator.clipboard.writeText(shareText);
      if (generation.current === run) { setNotice('Text copied. Paste it with your image or share it on its own.'); setError(''); }
    } catch {
      if (generation.current === run) setError('Clipboard access was blocked. Expand Share text below to select and copy it.');
    }
  }

  return <dialog
    ref={dialog}
    className="sd-dialog"
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) close(); }}
    aria-labelledby="share-title"
  >
    <header className="sd-header">
      <h2 id="share-title">Share result</h2>
      <div className="sd-header-actions">
        <div className="sd-theme-picker" role="group" aria-label="Image theme">
          <button type="button" aria-pressed={imageTheme === 'light'} disabled={copying} onClick={() => changeImageTheme('light')}>Light</button>
          <button type="button" aria-pressed={imageTheme === 'dark'} disabled={copying} onClick={() => changeImageTheme('dark')}>Dark</button>
        </div>
        <button className="sd-close" onClick={close} aria-label="Close sharing" title="Close (Esc)"><X size={20} /></button>
      </div>
    </header>

    <div className="sd-body">
      <figure className="sd-preview-frame" data-image-theme={imageTheme}>
        {url
          ? <img className="sd-preview" src={url} alt={`${imageTheme === 'light' ? 'Light' : 'Dark'} preview of your AI Diff result. The blue segment shows the share of counted additions after your comparison date.`} />
          : <div className="sd-image-loading" role="status">
              {!error && <LoaderCircle size={24} className="sd-loading-icon" aria-hidden="true" />}
              <span>{error ? 'Image unavailable.' : 'Preparing your image…'}</span>
            </div>}
      </figure>

      {needsConsent && <label className={`sd-consent${consent ? ' sd-consent-checked' : ''}`}>
        <input type="checkbox" checked={consent} onChange={event => { setConsent(event.target.checked); setError(''); setNotice(''); }} />
        <span><strong>Share private totals</strong><span>I’m comfortable sharing these numbers. Repository names and code are not included.</span></span>
      </label>}

      <div className="sd-action-area">
        <div className="sd-primary-row">
          <button className="button primary sd-copy-image" disabled={!blob || !consent || copying} onClick={() => void copyImage()} aria-keyshortcuts="Meta+Shift+C Control+Shift+C">
            <Copy size={16} /><span>{copying ? 'Copying…' : 'Copy image'}</span><kbd>⌘/Ctrl ⇧ C</kbd>
          </button>
        </div>
        <div className="sd-secondary-actions" role="group" aria-label="More ways to share">
          <button className="button secondary sd-secondary-action" aria-label="Download PNG" disabled={!blob || !consent} onClick={() => { if (blob && consent) { downloadShareImage(blob); setNotice('PNG downloaded.'); } }}>PNG</button>
          <button className="button secondary sd-secondary-action" aria-label="Copy text" disabled={!consent} onClick={() => void copyText()}>Text</button>
          <button className="link-button sd-link-action" aria-label="Copy result link" disabled={!consent} onClick={() => void copyLink()}>Link</button>
        </div>
      </div>

      {error && <p className="sd-feedback sd-error" role="alert">{error}</p>}
      {notice && <p className="sd-feedback sd-success" role="status"><Check size={17} aria-hidden="true" /><span>{notice}</span></p>}

      <p className="sd-sharing-note">Blue shows the share of lines added since your comparison date.</p>

      {consent && <div className="sd-fallbacks">
        <details className="sd-details">
          <summary>Result link</summary>
          <div className="sd-details-content"><p className="sd-field-note">Share the PNG for a personalized social preview.</p><input id="sd-result-link" aria-label="Result link" className="sd-copy-field" readOnly value={shareUrl} onFocus={event => event.target.select()} /></div>
        </details>
        <details className="sd-details">
          <summary>Share text</summary>
          <div className="sd-details-content"><textarea id="sd-share-text" aria-label="Share text" className="sd-copy-field sd-text-field" rows={8} readOnly value={shareText} onFocus={event => event.target.select()} /></div>
        </details>
      </div>}
    </div>
  </dialog>;
}
