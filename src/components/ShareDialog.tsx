import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, LoaderCircle, X } from 'lucide-react';
import type { ShareResult } from '../../shared/types';
import { copyShareImage, createShareText, createShareUrl, downloadShareImage, renderShareImage, type ShareImageTheme } from '../lib/share';
import { publishShare, type PublishedShare } from '../lib/published-share';
import { createXPostUrl, reserveXPostWindow, type XPostWindow } from '../lib/x-share';
import { getTheme } from '../lib/theme';
import './ShareDialog.css';

type ShareAction = 'image' | 'text' | 'link' | 'fallback' | 'publish' | 'x';
type ImagePreview = { resultKey: string; theme: ShareImageTheme; blob: Blob; url: string };
type LinkCache = { resultKey: string; links: Partial<Record<ShareImageTheme, PublishedShare>> };

export default function ShareDialog({ result, close, publishedShare }: { result: ShareResult; close: () => void; publishedShare?: PublishedShare }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const actionPending = useRef(false);
  const publication = useRef<AbortController | null>(null);
  const pendingXWindow = useRef<XPostWindow | null>(null);
  const resultKey = JSON.stringify(result);
  const [preview, setPreview] = useState<ImagePreview | null>(null);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [xPostUrl, setXPostUrl] = useState('');
  const [action, setAction] = useState<ShareAction | null>(null);
  const [imageTheme, setImageTheme] = useState<ShareImageTheme>(() => publishedShare?.imageTheme ?? getTheme());
  const [cache, setCache] = useState<LinkCache>(() => ({
    resultKey, links: publishedShare ? { [publishedShare.imageTheme]: publishedShare } : {},
  }));
  const currentPreview = preview?.resultKey === resultKey && preview.theme === imageTheme ? preview : null;
  const blob = currentPreview?.blob ?? null;
  const currentLink = (cache.resultKey === resultKey ? cache.links[imageTheme] : undefined)
    ?? (publishedShare?.imageTheme === imageTheme ? publishedShare : undefined);
  const fallbackUrl = createShareUrl(result);
  const shareText = createShareText(result) + (currentLink ? `\nResult: ${currentLink.url}` : '');
  const busy = action !== null;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => {
      element?.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    generation.current += 1;
    publication.current?.abort();
    publication.current = null;
    pendingXWindow.current?.close();
    pendingXWindow.current = null;
    actionPending.current = false;
    setAction(null);
    setXPostUrl('');
    setCache({ resultKey, links: publishedShare ? { [publishedShare.imageTheme]: publishedShare } : {} });
    setImageTheme(publishedShare?.imageTheme ?? getTheme());
    return () => {
      generation.current += 1;
      publication.current?.abort();
      publication.current = null;
      pendingXWindow.current?.close();
      pendingXWindow.current = null;
      actionPending.current = false;
    };
    // The serialized result identifies a new snapshot; theme changes keep cached links.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultKey]);

  useEffect(() => {
    const run = ++generation.current;
    let imageUrl = '';
    setPreview(null); setNotice(''); setError(''); setXPostUrl('');
    renderShareImage(result, imageTheme).then(value => {
      if (generation.current !== run) return;
      imageUrl = URL.createObjectURL(value);
      setPreview({ resultKey, theme: imageTheme, blob: value, url: imageUrl });
    }).catch(() => {
      if (generation.current === run) setError('The image could not be created. Try another theme, or use the text or link without upload below.');
    });
    return () => {
      generation.current += 1;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
    // Equal snapshot contents do not need a new image when the parent renders again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultKey, imageTheme]);

  function changeImageTheme(theme: ShareImageTheme) {
    if (theme === imageTheme || actionPending.current) return;
    generation.current += 1;
    setPreview(null); setNotice(''); setError(''); setXPostUrl('');
    setImageTheme(theme);
  }

  const copyImage = useCallback(async () => {
    if (actionPending.current) return;
    if (!blob) { setNotice('Your image is still preparing. Try the shortcut again in a moment.'); return; }
    const run = generation.current;
    actionPending.current = true;
    setAction('image'); setNotice(''); setError('');
    try {
      await copyShareImage(blob);
      if (generation.current === run) setNotice('Image copied. Paste it anywhere.');
    } catch {
      if (generation.current === run) setError('Your browser could not copy the image. Download the PNG instead.');
    } finally {
      if (generation.current === run) { actionPending.current = false; setAction(null); }
    }
  }, [blob]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault(); void copyImage();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [copyImage]);

  async function copyTextValue(value: string, kind: 'text' | 'fallback') {
    if (actionPending.current) return;
    const run = generation.current;
    actionPending.current = true;
    setAction(kind); setNotice(''); setError('');
    try {
      await navigator.clipboard.writeText(value);
      if (generation.current === run) setNotice(kind === 'text' ? 'Text copied.' : 'Link copied without uploading the image.');
    } catch {
      if (generation.current === run) setError(kind === 'text'
        ? 'Clipboard access was blocked. Expand Share text below to select and copy it.'
        : 'Clipboard access was blocked. Select and copy the Link without upload field below.');
    } finally {
      if (generation.current === run) { actionPending.current = false; setAction(null); }
    }
  }

  async function shareLink(destination: 'copy' | 'x') {
    if (actionPending.current || (!currentLink && !blob)) return;
    const run = generation.current;
    actionPending.current = true;
    // Reserve a tab during the click, before publishing yields user activation.
    const xWindow = destination === 'x' ? reserveXPostWindow() : null;
    pendingXWindow.current = xWindow;
    setAction(destination === 'x' ? 'x' : currentLink ? 'link' : 'publish'); setNotice(''); setError(''); setXPostUrl('');
    let controller: AbortController | null = null;
    try {
      let readyLink = currentLink;
      if (!readyLink && blob) {
        controller = new AbortController();
        publication.current = controller;
        readyLink = await publishShare(result, blob, imageTheme, controller.signal);
        if (generation.current !== run || controller.signal.aborted) return;
        const published = readyLink;
        setCache(previous => ({
          resultKey,
          links: { ...(previous.resultKey === resultKey ? previous.links : {}), [imageTheme]: published },
        }));
      }
      if (!readyLink || generation.current !== run) return;
      if (destination === 'x') {
        const intent = createXPostUrl(result, readyLink.url);
        if (xWindow?.open(intent)) {
          setNotice('X opened with your caption and result link.');
        } else {
          setXPostUrl(intent);
          setNotice('Your post is ready. Open X below.');
        }
      } else {
        try {
          await navigator.clipboard.writeText(readyLink.url);
          if (generation.current === run) setNotice('Result link copied. Its totals and image are public.');
        } catch {
          if (generation.current === run) setNotice('Link ready. Select the Result link field below to copy it.');
        }
      }
    } catch (reason) {
      if (generation.current === run && !controller?.signal.aborted) {
        const message = reason instanceof Error ? reason.message : 'The link could not be created.';
        setError(/PNG|without upload/i.test(message) ? message : `${message} You can still download the PNG or use Link without upload below.`);
      }
    } finally {
      // The window helper releases its reference after opening X; cleanup only
      // closes an unfinished preparation tab, never the user's composer.
      xWindow?.close();
      if (pendingXWindow.current === xWindow) pendingXWindow.current = null;
      if (publication.current === controller) publication.current = null;
      if (generation.current === run) { actionPending.current = false; setAction(null); }
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
          <button type="button" aria-pressed={imageTheme === 'light'} disabled={busy} onClick={() => changeImageTheme('light')}>Light</button>
          <button type="button" aria-pressed={imageTheme === 'dark'} disabled={busy} onClick={() => changeImageTheme('dark')}>Dark</button>
        </div>
        <button className="sd-close" onClick={close} aria-label="Close sharing" title="Close (Esc)"><X size={20} /></button>
      </div>
    </header>

    <div className="sd-body">
      <figure className="sd-preview-frame" data-image-theme={imageTheme}>
        {currentPreview
          ? <img className="sd-preview" src={currentPreview.url} alt={`${imageTheme === 'light' ? 'Light' : 'Dark'} preview of your AI Diff result. The blue segment shows the share of counted additions after your comparison date.`} />
          : <div className="sd-image-loading" role="status">
              {!error && <LoaderCircle size={24} className="sd-loading-icon" aria-hidden="true" />}
              <span>{error ? 'Image unavailable.' : 'Preparing your image…'}</span>
            </div>}
      </figure>

      <div className="sd-action-area" role="group" aria-label="Share options">
        <button className="button secondary sd-secondary-action sd-copy-image" disabled={!blob || busy} onClick={() => void copyImage()} aria-keyshortcuts="Meta+Shift+C Control+Shift+C" title="Copy image (⌘/Ctrl + Shift + C)">
          <Copy size={15} /><span>{action === 'image' ? 'Copying…' : 'Copy image'}</span>
        </button>
        <button className="button secondary sd-secondary-action" aria-label="Download PNG" disabled={!blob || busy} onClick={() => { if (blob) { downloadShareImage(blob); setNotice('PNG downloaded.'); setError(''); } }}>PNG</button>
        <button className="button secondary sd-secondary-action" aria-label="Copy text" disabled={busy} onClick={() => void copyTextValue(shareText, 'text')}>{action === 'text' ? 'Copying…' : 'Text'}</button>
        <button className="link-button sd-link-action sd-create-link" disabled={busy || (!currentLink && !blob)} onClick={() => void shareLink('copy')}>
          {action === 'publish' ? 'Creating link…' : action === 'link' ? 'Copying…' : currentLink ? 'Copy link' : 'Create link'}
        </button>
        <button className="link-button sd-link-action" disabled={busy || (!currentLink && !blob)} onClick={() => void shareLink('x')}>
          {action === 'x' ? 'Preparing post…' : 'Post on X'}
        </button>
      </div>

      <p className="sd-sharing-note">Create link and Post on X make these totals and this image public. No code or repository names are included.</p>

      {error && <p className="sd-feedback sd-error" role="alert">{error}</p>}
      {notice && <p className="sd-feedback sd-success" role="status"><Check size={17} aria-hidden="true" /><span>{notice}</span></p>}
      {xPostUrl && <a className="sd-open-x" href={xPostUrl} target="_blank" rel="noopener noreferrer">Open X</a>}

      {currentLink && <label className="sd-result-link">
        <span>Result link</span>
        <input id="sd-result-link" aria-label="Result link" className="sd-copy-field" readOnly value={currentLink.url} onFocus={event => event.target.select()} />
      </label>}

      <div className="sd-fallbacks">
        <details className="sd-details">
          <summary>Link without upload</summary>
          <div className="sd-details-content">
            <p className="sd-field-note">This long link keeps the totals in its URL. It does not upload an image or provide a personalized social preview.</p>
            <input id="sd-fallback-link" aria-label="Link without upload" className="sd-copy-field" readOnly value={fallbackUrl} onFocus={event => event.target.select()} />
            <button className="link-button sd-fallback-copy" disabled={busy} onClick={() => void copyTextValue(fallbackUrl, 'fallback')}>Copy link without upload</button>
          </div>
        </details>
        <details className="sd-details">
          <summary>Share text</summary>
          <div className="sd-details-content"><textarea id="sd-share-text" aria-label="Share text" className="sd-copy-field sd-text-field" rows={8} readOnly value={shareText} onFocus={event => event.target.select()} /></div>
        </details>
      </div>
    </div>
  </dialog>;
}
