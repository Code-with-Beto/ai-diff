import { afterEach, describe, expect, it, vi } from 'vitest';
import preset from '../public/share-sample.json';
import type { ShareResult } from '../shared/types';
import { createXPostUrl, reserveXPostWindow } from '../src/lib/x-share';

const sample = preset as ShareResult;
const result = { ...sample, sample: false };
const resultUrl = 'https://aidiff.cwb.sh/s/abcdefghijklmnop';
afterEach(() => vi.unstubAllGlobals());

describe('X post URLs', () => {
  it('encodes one caption and a public short link for the fixed X composer', () => {
    const url = new URL(createXPostUrl(result, resultUrl));
    expect(url.origin + url.pathname).toBe('https://x.com/intent/tweet');
    expect([...url.searchParams.keys()]).toEqual(['text', 'url']);
    expect(url.searchParams.get('text')).toBe('GitHub, before and after AI: 138,820 → 327,173 lines added.');
    expect(url.searchParams.get('url')).toBe(resultUrl);
    expect(url.hash).toBe('');
  });

  it.each(['light', 'dark'])('identifies sample data and supports the %s preset', theme => {
    const url = new URL(createXPostUrl(sample, `https://aidiff.cwb.sh/s/sample-${theme}`));
    expect(url.searchParams.get('text')).toMatch(/^Sample GitHub, before and after AI:/);
    expect(url.searchParams.get('url')).toBe(`https://aidiff.cwb.sh/s/sample-${theme}`);
  });

  it.each([
    { ...result, coverage: { completed: 3, unavailable: 1, incomplete: 0, total: 4 } },
    { ...result, coverage: { completed: 3, unavailable: 0, incomplete: 1, total: 4 } },
    { ...result, fileFilter: { ...result.fileFilter!, uninspectedBefore: { additions: 10, deletions: 0, commits: 1 } } },
    { ...result, fileFilter: { ...result.fileFilter!, uninspectedAfter: { additions: 10, deletions: 0, commits: 1 } } },
  ])('preserves partial-history context', snapshot => {
    expect(new URL(createXPostUrl(snapshot, resultUrl)).searchParams.get('text')).toMatch(/\(partial history\)$/);
  });

  it('does not call raw totals partial just because file inspection was incomplete', () => {
    const raw: ShareResult = { ...result, fileFilter: {
      enabled: false, excludedBefore: { additions: 0, deletions: 0 }, excludedAfter: { additions: 0, deletions: 0 },
      inspectedCommits: 817, uninspectedBefore: { additions: 10, deletions: 0, commits: 1 }, uninspectedAfter: { additions: 0, deletions: 0, commits: 0 },
    } };
    expect(new URL(createXPostUrl(raw, resultUrl)).searchParams.get('text')).not.toContain('partial');
  });

  it('supports local HTTP preview origins', () => {
    const url = new URL(createXPostUrl(result, 'http://localhost:5173/s/abcdefghijklmnop'));
    expect(url.searchParams.get('url')).toBe('http://localhost:5173/s/abcdefghijklmnop');
  });

  it.each([
    'javascript:alert(1)', 'ftp://aidiff.cwb.sh/s/abcdefghijklmnop', '/s/abcdefghijklmnop',
    'https://aidiff.cwb.sh/share#secret', 'https://aidiff.cwb.sh/s/short',
    `${resultUrl}?token=secret`, `${resultUrl}#secret`, `${resultUrl}?`, `${resultUrl}#`,
    'https://user:password@aidiff.cwb.sh/s/abcdefghijklmnop', 'https://@aidiff.cwb.sh/s/abcdefghijklmnop',
    `${resultUrl}/image.png`, `${resultUrl}/`, `${resultUrl} `, ` ${resultUrl}`, '',
  ])('rejects a non-public-result URL: %s', url => {
    expect(() => createXPostUrl(result, url)).toThrow('public result link');
  });

  it.each([null, {}, { ...result, before: { ...result.before, additions: -1 } }])('rejects malformed result input', input => {
    expect(() => createXPostUrl(input as ShareResult, resultUrl)).toThrow('valid result');
  });
});

function setupPopup() {
  const popup = {
    opener: {} as unknown,
    closed: false,
    document: { title: '', body: { textContent: '' } },
    location: { replace: vi.fn() },
    close: vi.fn(),
  };
  const open = vi.fn(() => popup);
  vi.stubGlobal('window', { open });
  return { popup, open };
}

describe('reserving an X composer window', () => {
  it('opens immediately, severs the opener and displays a preparation message', () => {
    const { popup, open } = setupPopup();
    expect(reserveXPostWindow()).not.toBeNull();
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(popup.opener).toBeNull();
    expect(popup.document.title).toBe('Preparing your post…');
    expect(popup.document.body.textContent).toBe('Preparing your post…');
    expect(popup.location.replace).not.toHaveBeenCalled();
  });

  it.each([null, 'throws'])('returns a safe fallback when window opening is blocked (%s)', behavior => {
    const open = vi.fn(() => { if (behavior === 'throws') throw new Error('Blocked'); return null; });
    vi.stubGlobal('window', { open });
    expect(reserveXPostWindow()).toBeNull();
  });

  it('closes the pending tab when preparation fails', () => {
    const { popup } = setupPopup();
    Object.defineProperty(popup, 'document', { get() { throw new Error('Detached'); } });
    expect(reserveXPostWindow()).toBeNull();
    expect(popup.close).toHaveBeenCalledOnce();
  });

  it('does not navigate a tab closed while the result was preparing', () => {
    const { popup } = setupPopup();
    const reserved = reserveXPostWindow()!;
    popup.closed = true;
    expect(reserved.open(createXPostUrl(result, resultUrl))).toBe(false);
    reserved.close();
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(popup.close).not.toHaveBeenCalled();
  });

  it('closes a still-pending tab if navigation fails', () => {
    const { popup } = setupPopup();
    const reserved = reserveXPostWindow()!;
    popup.location.replace.mockImplementation(() => { throw new Error('Navigation blocked'); });
    expect(reserved.open(createXPostUrl(result, resultUrl))).toBe(false);
    reserved.close();
    expect(popup.close).toHaveBeenCalledOnce();
  });

  it('cancels a pending tab once and prevents late navigation', () => {
    const { popup } = setupPopup();
    const reserved = reserveXPostWindow()!;
    reserved.close(); reserved.close();
    expect(popup.close).toHaveBeenCalledOnce();
    expect(reserved.open(createXPostUrl(result, resultUrl))).toBe(false);
    expect(popup.location.replace).not.toHaveBeenCalled();
  });

  it('never closes or navigates the user’s composer again after success', () => {
    const { popup } = setupPopup();
    const reserved = reserveXPostWindow()!;
    const intent = createXPostUrl(result, resultUrl);
    expect(reserved.open(intent)).toBe(true);
    reserved.close();
    expect(reserved.open(intent)).toBe(false);
    expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith(intent);
    expect(popup.close).not.toHaveBeenCalled();
  });
});
