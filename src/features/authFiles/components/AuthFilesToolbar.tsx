import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { IconChevronDown, IconSearch, IconSlidersHorizontal } from '@/components/ui/icons';
import { MAX_CARD_PAGE_SIZE, MIN_CARD_PAGE_SIZE } from '@/features/authFiles/constants';
import type { AuthFilesSortMode, AuthFilesStatusFilterMode } from '@/features/authFiles/uiState';
import styles from './AuthFilesToolbar.module.scss';

export type AuthFilesToolbarProps = {
  search: string;
  onSearchChange: (value: string) => void;
  statusFilterMode: AuthFilesStatusFilterMode;
  statusFilterOptions: Array<{ value: AuthFilesStatusFilterMode; label: string }>;
  onStatusFilterChange: (mode: AuthFilesStatusFilterMode) => void;
  sortMode: AuthFilesSortMode;
  sortOptions: Array<{ value: string; label: string }>;
  onSortModeChange: (value: string) => void;
  pageSizeInput: string;
  onPageSizeInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onPageSizeCommit: (rawValue: string) => void;
  compactMode: boolean;
  onCompactModeChange: (value: boolean) => void;
  deleteLabel: string;
  deleteDisabled: boolean;
  deleteLoading: boolean;
  onDelete: () => void;
};

/**
 * Search, plus one "Filter and view" menu holding status, sort, page size, compact mode
 * and the destructive "Delete all". One menu keeps the toolbar on a single row at any
 * width, and keeps the bulk delete out of reach of a stray click.
 */
export function AuthFilesToolbar(props: AuthFilesToolbarProps) {
  const {
    search,
    onSearchChange,
    statusFilterMode,
    statusFilterOptions,
    onStatusFilterChange,
    sortMode,
    sortOptions,
    onSortModeChange,
    pageSizeInput,
    onPageSizeInputChange,
    onPageSizeCommit,
    compactMode,
    onCompactModeChange,
    deleteLabel,
    deleteDisabled,
    deleteLoading,
    onDelete,
  } = props;
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const activeCount =
    (statusFilterMode !== 'all' ? 1 : 0) + (sortMode !== sortOptions[0]?.value ? 1 : 0);
  const statusLabel = statusFilterOptions.find((option) => option.value === statusFilterMode);

  return (
    <div className={styles.toolbar}>
      <div className={styles.search}>
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t('auth_files.search_placeholder')}
          aria-label={t('auth_files.search_label')}
          rightElement={<IconSearch className={styles.searchIcon} size={16} />}
        />
      </div>

      <div className={styles.menu} ref={menuRef}>
        <button
          type="button"
          className={`${styles.menuButton} ${open ? styles.menuButtonActive : ''}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-controls="auth-files-view-menu"
          onClick={() => setOpen((value) => !value)}
        >
          <IconSlidersHorizontal size={15} aria-hidden="true" />
          <span>{t('auth_files.view_menu_label')}</span>
          {activeCount > 0 && (
            <span className={styles.count} title={statusLabel?.label}>
              {activeCount}
            </span>
          )}
          <IconChevronDown size={14} aria-hidden="true" className={styles.chevron} />
        </button>

        {open && (
          <div
            id="auth-files-view-menu"
            className={styles.popover}
            role="dialog"
            aria-label={t('auth_files.view_menu_label')}
          >
            <div className={styles.group}>
              <span className={styles.groupLabel} id="auth-files-status-label">
                {t('auth_files.view_status_label')}
              </span>
              <div
                className={styles.segmented}
                role="group"
                aria-labelledby="auth-files-status-label"
              >
                {statusFilterOptions.map((option) => {
                  const isActive = statusFilterMode === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`${styles.segment} ${isActive ? styles.segmentActive : ''}`}
                      aria-pressed={isActive}
                      onClick={() => onStatusFilterChange(option.value)}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className={styles.row}>
              <label htmlFor="auth-files-sort">{t('auth_files.sort_label')}</label>
              <select
                id="auth-files-sort"
                className={styles.select}
                value={sortMode}
                onChange={(event) => onSortModeChange(event.target.value)}
              >
                {sortOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.row}>
              <label htmlFor="auth-files-page-size">{t('auth_files.page_size_label')}</label>
              <input
                id="auth-files-page-size"
                className={styles.pageSizeInput}
                type="number"
                min={MIN_CARD_PAGE_SIZE}
                max={MAX_CARD_PAGE_SIZE}
                step={1}
                value={pageSizeInput}
                onChange={onPageSizeInputChange}
                onBlur={(e) => onPageSizeCommit(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
            </div>
            <div className={styles.row}>
              <span>{t('auth_files.compact_mode_label')}</span>
              <ToggleSwitch
                checked={compactMode}
                onChange={onCompactModeChange}
                ariaLabel={t('auth_files.compact_mode_label')}
              />
            </div>

            <div className={styles.divider} role="separator" />
            <button
              type="button"
              className={styles.deleteAction}
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
              disabled={deleteDisabled}
            >
              {deleteLoading && <LoadingSpinner size={13} />}
              {deleteLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
