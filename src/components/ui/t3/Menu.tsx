/**
 * A small action menu behind an icon trigger, styled after T3 Code's menu (MIT, see
 * THIRD_PARTY_NOTICES.md). Closes on outside click, Escape or after an item runs.
 * Destructive items sit last, after a separator, so they are never the first thing hit.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import styles from './Menu.module.scss';

export interface MenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

export function Menu({
  trigger,
  label,
  items,
  disabled,
  className,
}: {
  trigger: ReactNode;
  /** Accessible name and tooltip for the trigger. */
  label: string;
  items: MenuItem[];
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const regular = items.filter((item) => !item.destructive);
  const destructive = items.filter((item) => item.destructive);
  const renderItem = (item: MenuItem) => (
    <button
      key={item.key}
      type="button"
      role="menuitem"
      className={`${styles.item} ${item.destructive ? styles.destructive : ''}`}
      disabled={item.disabled}
      onClick={() => {
        setOpen(false);
        item.onSelect();
      }}
    >
      {item.icon && <span className={styles.icon}>{item.icon}</span>}
      <span>{item.label}</span>
    </button>
  );

  return (
    <div className={[styles.root, className].filter(Boolean).join(' ')} ref={rootRef}>
      <button
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger}
      </button>
      {open && (
        <div id={menuId} role="menu" className={styles.menu}>
          {regular.map(renderItem)}
          {regular.length > 0 && destructive.length > 0 && (
            <div className={styles.separator} role="separator" />
          )}
          {destructive.map(renderItem)}
        </div>
      )}
    </div>
  );
}
