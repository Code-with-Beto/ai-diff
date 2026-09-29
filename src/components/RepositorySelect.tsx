import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Archive, Check, LockKeyhole } from 'lucide-react';
import type { Repository } from '../../shared/types';
import './RepositorySelect.css';

type RepositorySelectProps = {
  repositories: Repository[];
  selected: Set<string>;
  disabled: boolean;
  loading: boolean;
  onToggle: (id: string, selected: boolean) => void;
};

/** A multi-select listbox: arrows move focus and Space toggles the focused option. */
export default function RepositorySelect({ repositories, selected, disabled, loading, onToggle }: RepositorySelectProps) {
  const list = useRef<HTMLDivElement>(null);
  const options = useRef(new Map<string, HTMLDivElement>());
  const focusWithin = useRef(false);
  const [activeId, setActiveId] = useState<string | null>(() => repositories.find(repository => selected.has(repository.id))?.id ?? repositories[0]?.id ?? null);
  const currentId = repositories.some(repository => repository.id === activeId)
    ? activeId
    : repositories.find(repository => selected.has(repository.id))?.id ?? repositories[0]?.id ?? null;

  useLayoutEffect(() => {
    if (activeId === currentId) return;
    setActiveId(currentId);
    // Updating search results must not pull focus out of the search field.
    if (focusWithin.current) {
      const target = currentId ? options.current.get(currentId) : list.current;
      target?.focus({ preventScroll: true });
    }
  }, [activeId, currentId]);

  function focusOption(id: string) {
    setActiveId(id);
    const option = options.current.get(id);
    option?.focus({ preventScroll: true });
    option?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!repositories.length || event.metaKey || event.ctrlKey || event.altKey) return;
    const index = repositories.findIndex(repository => repository.id === currentId);
    let nextIndex: number | undefined;
    if (event.key === 'ArrowDown') nextIndex = Math.min(index + 1, repositories.length - 1);
    else if (event.key === 'ArrowUp') nextIndex = Math.max(index - 1, 0);
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = repositories.length - 1;
    else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (!disabled && currentId) onToggle(currentId, !selected.has(currentId));
      return;
    }
    if (nextIndex !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      focusOption(repositories[nextIndex].id);
    }
  }

  return <div className="repository-select">
    <div
      ref={list}
      className="repository-select-list"
      role="listbox"
      aria-label="Repositories"
      aria-multiselectable="true"
      aria-disabled={disabled || undefined}
      aria-busy={loading || undefined}
      tabIndex={repositories.length ? -1 : 0}
      onKeyDown={handleKeyDown}
      onFocusCapture={() => { focusWithin.current = true; }}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) focusWithin.current = false;
      }}
    >
      {repositories.map(repository => {
        const slash = repository.nameWithOwner.indexOf('/');
        const isSelected = selected.has(repository.id);
        return <div
          key={repository.id}
          ref={element => {
            if (element) options.current.set(repository.id, element);
            else options.current.delete(repository.id);
          }}
          className="repository-select-option"
          role="option"
          aria-label={`${repository.nameWithOwner}${repository.isPrivate ? ', private' : ''}${repository.isArchived ? ', archived' : ''}`}
          aria-selected={isSelected}
          aria-disabled={disabled || undefined}
          tabIndex={repository.id === currentId ? 0 : -1}
          onFocus={() => setActiveId(repository.id)}
          onClick={() => {
            focusOption(repository.id);
            if (!disabled) onToggle(repository.id, !isSelected);
          }}
        >
          <span className="repository-select-name" title={repository.nameWithOwner}>
            {slash >= 0 && <span className="repository-select-owner">{repository.nameWithOwner.slice(0, slash + 1)}</span>}
            {repository.nameWithOwner.slice(slash + 1)}
          </span>
          <span className="repository-select-indicators" aria-hidden="true">
            {repository.isArchived && <span title="Archived"><Archive size={13} /></span>}
            {repository.isPrivate && <span title="Private"><LockKeyhole size={13} /></span>}
          </span>
          <span className="repository-select-check" aria-hidden="true">{isSelected && <Check size={16} strokeWidth={2} />}</span>
        </div>;
      })}
    </div>
    {!repositories.length && <p className="repository-select-empty" role="status">{loading ? 'Loading repositories…' : 'No matching repositories.'}</p>}
  </div>;
}
