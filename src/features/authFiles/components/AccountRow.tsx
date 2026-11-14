/**
 * One Claude or Codex account on the Accounts page: everything the old Limits row showed
 * (plan, 5-hour, weekly and model limits with reset times, banked resets, Refresh quota,
 * Reset limits) plus what the old account card held (selection, status and cooldown
 * notices, Models, the credential menu and the Enabled switch), and the account's use
 * in the chosen range.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconDownload,
  IconModelCluster,
  IconRefreshCw,
  IconSettings,
  IconTrash2,
} from '@/components/ui/icons';
import { ErrorNotice, Menu } from '@/components/ui/t3';
import type { AuthFileItem } from '@/types';
import { getAuthFileRefreshKey } from '@/features/authFiles/manualRefresh';
import {
  getAuthFileStatusMessage,
  hasAuthFileStatusWarning,
  normalizeProviderKey,
  supportsAuthFileManualRefresh,
} from '@/features/authFiles/constants';
import { QuotaRow } from '@/features/quota/components/QuotaRow';
import type { QuotaFileEntry } from '@/features/quota/logic';
import type { QuotaCardState } from '@/features/quota/providers';
import { AuthFileCooldownSection } from './AuthFileCooldownSection';
import styles from './AccountRow.module.scss';

export interface AccountRowProps {
  file: AuthFileItem;
  entry: QuotaFileEntry;
  quota: QuotaCardState | undefined;
  canRefresh: boolean;
  resetting: boolean;
  creditOverageSharedCount?: number;
  onRefreshQuota: () => void;
  onResetQuota: () => void;
  selected: boolean;
  disableControls: boolean;
  deleting: string | null;
  statusUpdating: Record<string, boolean>;
  manualRefreshing: Record<string, boolean>;
  cooldownResetting: Record<string, boolean>;
  usage?: ReactNode;
  onToggleSelect: (name: string) => void;
  onShowModels: (file: AuthFileItem) => void;
  onDownload: (name: string) => void;
  onManualRefresh: (file: AuthFileItem) => void;
  onCooldownReset: (file: AuthFileItem) => void;
  onOpenPrefixProxyEditor: (file: AuthFileItem) => void;
  onDelete: (name: string) => void;
  onToggleStatus: (file: AuthFileItem, enabled: boolean) => void;
}

export function AccountRow(props: AccountRowProps) {
  const { t } = useTranslation();
  const { file, disableControls, deleting, statusUpdating, manualRefreshing, cooldownResetting } =
    props;
  const refreshKey = getAuthFileRefreshKey(file);
  const isManualRefreshing = manualRefreshing[refreshKey] === true;
  const updating = statusUpdating[refreshKey] === true;
  const providerKey = normalizeProviderKey(String(file.type ?? file.provider ?? 'unknown'));
  const authIndexKey = typeof file.authIndex === 'string' ? file.authIndex : null;
  const statusMessage = getAuthFileStatusMessage(file);
  const showWarning = Boolean(statusMessage) && hasAuthFileStatusWarning(file);
  const snapshot = file.cooldownSnapshot;
  const hasCooldown = Boolean(
    snapshot && (snapshot.records === null || snapshot.records.length > 0)
  );

  const notices =
    showWarning || hasCooldown ? (
      <div className={styles.notices}>
        {showWarning && (
          <ErrorNotice
            error={statusMessage}
            detailsLabel={t('common.details', { defaultValue: 'Details' })}
          />
        )}
        <AuthFileCooldownSection
          snapshot={file.cooldownSnapshot}
          resetting={Boolean(authIndexKey && cooldownResetting[authIndexKey])}
          resetDisabled={disableControls || updating || isManualRefreshing}
          onReset={authIndexKey ? () => props.onCooldownReset(file) : undefined}
        />
      </div>
    ) : null;

  const controls = (
    <>
      <Button
        variant="secondary"
        size="sm"
        className={styles.models}
        onClick={() => props.onShowModels(file)}
        disabled={disableControls}
        title={t('auth_files.models_button')}
      >
        <IconModelCluster size={13} />
        {t('auth_files.models_button')}
      </Button>
      <Menu
        label={t('auth_files.row_menu_label')}
        trigger={
          deleting === file.name || isManualRefreshing ? (
            <LoadingSpinner size={13} />
          ) : (
            <IconSettings size={14} />
          )
        }
        disabled={disableControls}
        items={[
          {
            key: 'details',
            label: t('auth_files.prefix_proxy_button'),
            icon: <IconSettings size={14} />,
            onSelect: () => props.onOpenPrefixProxyEditor(file),
          },
          ...(supportsAuthFileManualRefresh(providerKey)
            ? [
                {
                  key: 'refresh-credential',
                  label: t('auth_files.manual_refresh_button'),
                  icon: <IconRefreshCw size={14} />,
                  disabled: file.disabled === true || updating || isManualRefreshing,
                  onSelect: () => props.onManualRefresh(file),
                },
              ]
            : []),
          {
            key: 'download',
            label: t('auth_files.download_button'),
            icon: <IconDownload size={14} />,
            onSelect: () => props.onDownload(file.name),
          },
          {
            key: 'delete',
            label: t('auth_files.delete_button'),
            icon: <IconTrash2 size={14} />,
            destructive: true,
            disabled: deleting === file.name || isManualRefreshing,
            onSelect: () => props.onDelete(file.name),
          },
        ]}
      />
      <span className={styles.toggle}>
        <ToggleSwitch
          ariaLabel={t('auth_files.card_toggle', { name: file.name })}
          checked={!file.disabled}
          disabled={disableControls || updating || isManualRefreshing}
          onChange={(value) => props.onToggleStatus(file, value)}
        />
      </span>
    </>
  );

  return (
    <QuotaRow
      entry={props.entry}
      quota={props.quota}
      canRefresh={props.canRefresh}
      resetting={props.resetting}
      creditOverageSharedCount={props.creditOverageSharedCount}
      onRefresh={props.onRefreshQuota}
      onReset={props.onResetQuota}
      selection={
        <SelectionCheckbox
          checked={props.selected}
          onChange={() => props.onToggleSelect(file.name)}
          className={styles.selection}
          ariaLabel={t('auth_files.card_select', { name: file.name })}
          title={t('auth_files.card_select', { name: file.name })}
        />
      }
      notices={notices}
      controls={controls}
      usage={props.usage}
    />
  );
}
