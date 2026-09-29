import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, Link2, X } from 'lucide-react';
import type { ShareResult } from '../../shared/types';
import { copyShareImage, createShareText, createShareUrl, downloadShareImage, renderShareImage } from '../lib/share';

export default function ShareDialog({ result, close }: { result: ShareResult; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const [blob, setBlob] = useState<Blob | null>(null), [url, setUrl] = useState(''), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [copying, setCopying] = useState(false);
  const needsConsent = result.includesPrivate && !result.sample;
  const [consent, setConsent] = useState(!needsConsent);
  const shareUrl = createShareUrl(result);
  const shareText = createShareText(result);

  useEffect(() => {
    const run = ++generation.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    let imageUrl = '';
    setBlob(null); setUrl(''); setNotice(''); setError(''); setCopying(false); setConsent(!needsConsent);
    renderShareImage(result).then(value => {
      if (generation.current !== run) return;
      setBlob(value); imageUrl = URL.createObjectURL(value); setUrl(imageUrl);
    }).catch(() => { if (generation.current === run) setError('The image could not be created. Close this panel and try again.'); });
    return () => {
      generation.current += 1;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      element?.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [result, needsConsent]);

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

  return <dialog ref={dialog} className="share-dialog" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }} aria-labelledby="share-title"><div className="dialog-inner"><div className="dialog-heading"><div><span className="eyebrow">YOUR NUMBERS. YOUR STORY.</span><h2 id="share-title">Worth a diff.</h2></div><button className="icon-button" onClick={close} aria-label="Close sharing"><X size={20} /></button></div>
    {url ? <img className="share-preview" src={url} alt="Preview of your AI Diff result image" /> : <div className="image-loading" role="status">{error ? 'Image unavailable.' : 'Preparing your image…'}</div>}
    {needsConsent && <label className="private-consent"><input type="checkbox" checked={consent} onChange={event => { setConsent(event.target.checked); setError(''); setNotice(''); }} /><span>This result includes private repository totals. I’m comfortable sharing these numbers.</span></label>}
    <div className="share-actions"><button className="button primary" disabled={!blob || !consent || copying} onClick={() => void copyImage()}><Copy size={16} />{copying ? 'Copying…' : 'Copy image'} <kbd>⌘/Ctrl ⇧ C</kbd></button><button className="button secondary" disabled={!blob || !consent} onClick={() => { if (blob && consent) { downloadShareImage(blob); setNotice('PNG downloaded.'); } }}><Download size={16} />PNG</button><button className="button secondary" disabled={!consent} onClick={() => void copyText()}><Copy size={16} />Copy text</button><button className="button secondary" disabled={!consent} onClick={() => void copyLink()}><Link2 size={16} />Copy result link</button></div>
    <p className="small-text">Only your handle, totals, dates, and coverage are shared. No repository names or code. Links display this result without uploading it; social feeds won’t generate a personalized image preview.</p>
    {consent && <details className="share-link-details"><summary>Result link</summary><input aria-label="Result link" className="link-fallback" readOnly value={shareUrl} onFocus={event => event.target.select()} /></details>}
    {consent && <details className="share-link-details share-text-details"><summary>Share text</summary><textarea aria-label="Share text" className="link-fallback share-text-fallback" rows={8} readOnly value={shareText} onFocus={event => event.target.select()} /></details>}
    {error && <p className="error-message" role="alert">{error}</p>}{notice && <p className="success-message" role="status"><Check size={15} />{notice}</p>}
  </div></dialog>;
}
