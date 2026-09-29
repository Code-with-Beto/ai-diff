import { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { ChevronDown } from 'lucide-react';
import './FilterDropdown.css';

type FilterDropdownProps = {
  label: ReactNode;
  ariaLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  initialFocusRef?: RefObject<HTMLInputElement | null>;
};

function focusFirstControl(panel: HTMLDivElement | null) {
  if (!panel) return;
  const controls = panel.querySelectorAll<HTMLElement>(
    'input:not([disabled]):not([type="hidden"]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex="0"]',
  );
  const first = Array.from(controls).find(control => control.getClientRects().length > 0
    && !control.closest('[hidden], [inert]') && control.getAttribute('aria-disabled') !== 'true');
  (first ?? panel).focus({ preventScroll: true });
}

/** A disclosure for filter forms, with normal keyboard navigation inside. */
export default function FilterDropdown({
  label, ariaLabel, open, onOpenChange, children, disabled = false, className = '', initialFocusRef,
}: FilterDropdownProps) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef(false);

  useLayoutEffect(() => {
    if (!open) return;
    if (initialFocusRef?.current) initialFocusRef.current.focus({ preventScroll: true });
    else if (focusOnOpen.current) focusFirstControl(panel.current);
    focusOnOpen.current = false;
  }, [open, initialFocusRef]);

  useLayoutEffect(() => {
    if (!open) return;
    const updateBounds = () => {
      if (!panel.current) return;
      panel.current.style.setProperty('--filter-popover-offset', '0px');
      if (window.innerWidth > 700) {
        const overflow = panel.current.getBoundingClientRect().right - window.innerWidth + 16;
        if (overflow > 0) panel.current.style.setProperty('--filter-popover-offset', `${-overflow}px`);
      }
      const viewport = window.visualViewport;
      panel.current.style.setProperty('--filter-popover-top', `${(viewport?.offsetTop ?? 0) + 16}px`);
      const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      const available = Math.max(0, bottom - panel.current.getBoundingClientRect().top - 16);
      panel.current.style.setProperty('--filter-popover-height', `${available}px`);
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
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) onOpenChange(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open, onOpenChange]);

  return <div
    ref={container}
    className={`filter-dropdown ${className}`.trim()}
    onBlur={event => {
      if (open && !event.currentTarget.contains(event.relatedTarget)) onOpenChange(false);
    }}
    onKeyDown={event => {
      if (open && event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        onOpenChange(false);
        trigger.current?.focus();
      }
    }}
  >
    <button
      ref={trigger}
      type="button"
      className="filter-trigger"
      aria-label={ariaLabel}
      aria-expanded={open}
      aria-controls={id}
      disabled={disabled}
      onClick={() => onOpenChange(!open)}
      onKeyDown={event => {
        if (event.key !== 'ArrowDown') return;
        event.preventDefault();
        if (open) focusFirstControl(panel.current);
        else {
          focusOnOpen.current = true;
          onOpenChange(true);
        }
      }}
    >
      <span className="filter-trigger-label">{label}</span>
      <ChevronDown className="filter-trigger-chevron" size={15} aria-hidden="true" />
    </button>
    {open && <div ref={panel} id={id} className="filter-popover" role="group" aria-label={ariaLabel} tabIndex={-1}>
      {children}
    </div>}
  </div>;
}
