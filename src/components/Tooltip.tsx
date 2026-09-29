import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import './Tooltip.css';

type TooltipTrigger = ReactElement<{ 'aria-describedby'?: string }>;

function TooltipContent({
  children, content, id: providedId, tapToToggle = false,
}: { children: TooltipTrigger; content: ReactNode; id?: string; tapToToggle?: boolean }) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const anchor = useRef<HTMLSpanElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const pinned = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: -9999, top: -9999 });

  function clearCloseTimer() { clearTimeout(closeTimer.current); }
  function close() {
    clearCloseTimer();
    pinned.current = false;
    setOpen(false);
  }

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  useLayoutEffect(() => {
    if (!open) return;
    const updateBounds = () => {
      if (!anchor.current || !tooltip.current) return;
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      tooltip.current.style.maxWidth = `${Math.max(0, Math.min(300, viewportWidth - 24))}px`;
      tooltip.current.style.maxHeight = `${Math.max(0, viewportHeight - 24)}px`;
      const target = anchor.current.getBoundingClientRect();
      const popup = tooltip.current.getBoundingClientRect();
      const left = Math.max(viewportLeft + 12, Math.min(
        target.left + (target.width - popup.width) / 2,
        viewportLeft + viewportWidth - popup.width - 12,
      ));
      const above = target.top - popup.height - 8;
      const top = Math.max(viewportTop + 12, Math.min(
        above >= viewportTop + 12 ? above : target.bottom + 8,
        viewportTop + viewportHeight - popup.height - 12,
      ));
      setPosition({ left, top });
    };
    updateBounds();
    window.addEventListener('resize', updateBounds);
    window.addEventListener('scroll', updateBounds, true);
    window.visualViewport?.addEventListener('resize', updateBounds);
    window.visualViewport?.addEventListener('scroll', updateBounds);
    return () => {
      window.removeEventListener('resize', updateBounds);
      window.removeEventListener('scroll', updateBounds, true);
      window.visualViewport?.removeEventListener('resize', updateBounds);
      window.visualViewport?.removeEventListener('scroll', updateBounds);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target)) {
        clearTimeout(closeTimer.current);
        pinned.current = false;
        setOpen(false);
      }
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(closeTimer.current);
      pinned.current = false;
      setOpen(false);
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('keydown', dismissOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('keydown', dismissOnEscape, true);
    };
  }, [open]);

  const describedBy = [children.props['aria-describedby'], id].filter(Boolean).join(' ');
  return <span
    ref={anchor}
    className="tooltip-anchor"
    onPointerEnter={event => {
      clearCloseTimer();
      if (event.pointerType === 'mouse') setOpen(true);
    }}
    onPointerLeave={() => {
      clearCloseTimer();
      if (!pinned.current && !anchor.current?.contains(document.activeElement)) {
        closeTimer.current = setTimeout(() => setOpen(false), 100);
      }
    }}
    onFocus={() => { clearCloseTimer(); setOpen(true); }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}
    onClick={tapToToggle ? () => {
      clearCloseTimer();
      pinned.current = !pinned.current;
      setOpen(pinned.current);
    } : undefined}
    onKeyDown={event => {
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }}
  >
    {cloneElement(children, { 'aria-describedby': describedBy })}
    <span ref={tooltip} id={id} className="control-tooltip" role="tooltip" hidden={!open} style={position}>{content}</span>
  </span>;
}

/** Add a text tooltip to an existing button without changing its action or name. */
export function Tooltip({ label, children }: { label: string; children: TooltipTrigger }) {
  return <TooltipContent content={label}>{children}</TooltipContent>;
}

/** Explanatory text only: keep links and other controls outside tooltips. */
export function HelpTooltip({ label, children, id }: { label: string; children: ReactNode; id?: string }) {
  return <TooltipContent content={children} id={id} tapToToggle>
    <button type="button" className="help-tooltip-button" aria-label={label}>
      <Info size={15} aria-hidden="true" />
    </button>
  </TooltipContent>;
}
