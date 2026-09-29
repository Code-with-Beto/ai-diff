import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';

export default function ComparisonDateHelp() {
  const [open, setOpen] = useState(false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);

  return <div className="date-help" ref={container} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={trigger} type="button" className="icon-button date-help-trigger" aria-label="About the comparison date" aria-expanded={open} aria-controls={id} aria-describedby={open ? id : undefined} onClick={() => setOpen(value => !value)}><Info size={15} aria-hidden="true" /></button>
    {open && <div id={id} className="date-help-popover" role="note">
      <p>When did AI become part of your workflow?</p>
      <p>We split your commits at midnight UTC on this date. Earlier commits go under Before; this date onward goes under After.</p>
      <p>The presets are model release dates. Choose your own date, or change it after a scan.</p>
    </div>}
  </div>;
}
