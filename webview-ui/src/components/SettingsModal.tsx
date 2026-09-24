import { useEffect, useRef, useState } from 'react';

import {
  IDLE_TO_LOUNGE_MINUTES_DEFAULT,
  IDLE_TO_LOUNGE_MINUTES_MAX,
  IDLE_TO_LOUNGE_MINUTES_MIN,
  LOUNGE_TO_LEAVE_MINUTES_DEFAULT,
  LOUNGE_TO_LEAVE_MINUTES_MAX,
  LOUNGE_TO_LEAVE_MINUTES_MIN,
} from '../constants.js';
import { isSoundEnabled, setSoundEnabled } from '../notificationSound.js';
import {
  clampIdleToLoungeMinutes,
  clampLoungeToLeaveMinutes,
} from '../office/living/livingOfficeController.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
import { Checkbox } from './ui/Checkbox.js';
import { MenuItem } from './ui/MenuItem.js';
import { Modal } from './ui/Modal.js';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  isDebugMode: boolean;
  onToggleDebugMode: () => void;
  alwaysShowOverlay: boolean;
  onToggleAlwaysShowOverlay: () => void;
  /** Whether headless agents (adopted, no terminal to focus) render translucent. */
  ghostHeadlessAgents: boolean;
  onToggleGhostHeadlessAgents: () => void;
  externalAssetDirectories: string[];
  watchAllSessions: boolean;
  onToggleWatchAllSessions: () => void;
  /** ACTUAL install state (the hooksStatus message), not the hooksEnabled
   *  preference. The preference defaults to true while first-run consent is
   *  still pending, so binding the checkbox to it renders "on" over an empty
   *  ~/.claude/settings.json. */
  hooksInstalled: boolean;
  onToggleHooksEnabled: () => void;
  /** Whether the areas overlay is rendered outside of the Areas edit tool. */
  showAreas: boolean;
  onToggleShowAreas: () => void;
  /** Hide the Show Areas checkbox entirely when areas are unavailable. */
  showAreasAvailable: boolean;
  /** Browser-native layout export (standalone only; VS Code uses the host save dialog). */
  onExportLayout: () => void;
  /** Browser-native layout import from a chosen file (standalone only). */
  onImportLayout: (file: File) => void;
  /** Minutes an available agent waits before walking to the lounge (null = not reported yet). */
  idleToLoungeMinutes: number | null;
  onChangeIdleToLoungeMinutes: (minutes: number) => void;
  /** Minutes an unused agent rests in the lounge before leaving (null = not reported yet). */
  loungeToLeaveMinutes: number | null;
  onChangeLoungeToLeaveMinutes: (minutes: number) => void;
}

/** A living-office delay in minutes: typed, committed on Enter or blur,
 *  clamped to the server's range; an invalid entry snaps back. The field only
 *  ever settles on what the server reports (`value`): a committed change shows
 *  the current value until the server's answer arrives, so a refused change
 *  never looks applied. */
function MinutesField({
  label,
  testId,
  value,
  fallback,
  min,
  max,
  clamp,
  onCommit,
}: {
  label: string;
  testId: string;
  value: number | null;
  fallback: number;
  min: number;
  max: number;
  clamp: (raw: string) => number | null;
  onCommit: (minutes: number) => void;
}) {
  const current = value ?? fallback;
  const [draft, setDraft] = useState(String(current));
  // Only a value the user typed is ever sent: focusing and leaving the field
  // (or the server not having reported its value yet) sends nothing.
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    setDraft(String(current));
    setEdited(false);
  }, [current]);
  const commit = () => {
    if (!edited) return;
    setEdited(false);
    const minutes = clamp(draft);
    setDraft(String(current));
    if (minutes !== null && minutes !== current) onCommit(minutes);
  };
  return (
    <label className="flex items-center justify-between gap-8 py-6 px-10">
      <span>{label}</span>
      <input
        type="number"
        data-testid={testId}
        // Nothing to change until the server has said what it applies.
        disabled={value === null}
        min={min}
        max={max}
        step={1}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setEdited(true);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        className="w-64 shrink-0 text-xs py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
      />
    </label>
  );
}

export function SettingsModal({
  isOpen,
  onClose,
  isDebugMode,
  onToggleDebugMode,
  alwaysShowOverlay,
  onToggleAlwaysShowOverlay,
  ghostHeadlessAgents,
  onToggleGhostHeadlessAgents,
  externalAssetDirectories,
  watchAllSessions,
  onToggleWatchAllSessions,
  hooksInstalled,
  onToggleHooksEnabled,
  showAreas,
  onToggleShowAreas,
  showAreasAvailable,
  onExportLayout,
  onImportLayout,
  idleToLoungeMinutes,
  onChangeIdleToLoungeMinutes,
  loungeToLeaveMinutes,
  onChangeLoungeToLeaveMinutes,
}: SettingsModalProps) {
  const [soundLocal, setSoundLocal] = useState(isSoundEnabled);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [assetDirDraft, setAssetDirDraft] = useState('');

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Settings">
      {/* Open Sessions Folder opens an OS file manager — impossible in the browser. */}
      {!isBrowserRuntime && (
        <MenuItem
          onClick={() => {
            transport.send({ type: 'openSessionsFolder' });
            onClose();
          }}
        >
          Open Sessions Folder
        </MenuItem>
      )}
      <MenuItem
        onClick={() => {
          if (isBrowserRuntime) {
            onExportLayout();
          } else {
            transport.send({ type: 'exportLayout' });
          }
          onClose();
        }}
      >
        Export Layout
      </MenuItem>
      <MenuItem
        onClick={() => {
          if (isBrowserRuntime) {
            // Open the native file picker; the import is applied in onChange below.
            fileInputRef.current?.click();
          } else {
            transport.send({ type: 'importLayout' });
            onClose();
          }
        }}
      >
        Import Layout
      </MenuItem>
      {isBrowserRuntime && (
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset the value so re-selecting the same file fires change again.
            e.target.value = '';
            if (file) {
              onImportLayout(file);
              onClose();
            }
          }}
        />
      )}
      {/* Browser has no native directory picker, so accept a typed absolute path. */}
      {isBrowserRuntime ? (
        <div className="flex items-center gap-4 py-4 px-10">
          <input
            type="text"
            value={assetDirDraft}
            placeholder="Absolute asset directory path"
            onChange={(e) => setAssetDirDraft(e.target.value)}
            className="flex-1 min-w-0 text-xs py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
          />
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              const path = assetDirDraft.trim();
              if (!path) return;
              transport.send({ type: 'addExternalAssetDirectory', path });
              setAssetDirDraft('');
            }}
            className="shrink-0"
          >
            Add
          </Button>
        </div>
      ) : (
        <MenuItem
          onClick={() => {
            transport.send({ type: 'addExternalAssetDirectory' });
            onClose();
          }}
        >
          Add Asset Directory
        </MenuItem>
      )}
      {externalAssetDirectories.map((dir) => (
        <div key={dir} className="flex items-center justify-between py-4 px-10 gap-8">
          <span
            className="text-xs text-text-muted overflow-hidden text-ellipsis whitespace-nowrap"
            title={dir}
          >
            {dir.split(/[/\\]/).pop() ?? dir}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => transport.send({ type: 'removeExternalAssetDirectory', path: dir })}
            className="shrink-0"
          >
            x
          </Button>
        </div>
      ))}
      <Checkbox
        label="Sound Notifications"
        checked={soundLocal}
        onChange={() => {
          const newVal = !isSoundEnabled();
          setSoundEnabled(newVal);
          setSoundLocal(newVal);
          transport.send({ type: 'setSoundEnabled', enabled: newVal });
        }}
      />
      <Checkbox
        label="Watch All Sessions"
        checked={watchAllSessions}
        onChange={onToggleWatchAllSessions}
      />
      <Checkbox
        label="Instant Detection (Hooks)"
        checked={hooksInstalled}
        onChange={onToggleHooksEnabled}
      />
      <Checkbox
        label="Always Show Labels"
        checked={alwaysShowOverlay}
        onChange={onToggleAlwaysShowOverlay}
      />
      {/* Headless agents are the office's only terminal-less citizens in VS Code.
          Standalone has no terminals at all, so nothing there would ever ghost. */}
      {!isBrowserRuntime && (
        <Checkbox
          label="Display Headless as Ghosts"
          checked={ghostHeadlessAgents}
          onChange={onToggleGhostHeadlessAgents}
        />
      )}
      {showAreasAvailable && (
        <Checkbox label="Show Areas" checked={showAreas} onChange={onToggleShowAreas} />
      )}
      <MinutesField
        label="Minutos hasta el descanso"
        testId="idle-to-lounge-minutes"
        value={idleToLoungeMinutes}
        fallback={IDLE_TO_LOUNGE_MINUTES_DEFAULT}
        min={IDLE_TO_LOUNGE_MINUTES_MIN}
        max={IDLE_TO_LOUNGE_MINUTES_MAX}
        clamp={clampIdleToLoungeMinutes}
        onCommit={onChangeIdleToLoungeMinutes}
      />
      <MinutesField
        label="Minutos en descanso antes de irse"
        testId="lounge-to-leave-minutes"
        value={loungeToLeaveMinutes}
        fallback={LOUNGE_TO_LEAVE_MINUTES_DEFAULT}
        min={LOUNGE_TO_LEAVE_MINUTES_MIN}
        max={LOUNGE_TO_LEAVE_MINUTES_MAX}
        clamp={clampLoungeToLeaveMinutes}
        onCommit={onChangeLoungeToLeaveMinutes}
      />
      <Checkbox label="Debug View" checked={isDebugMode} onChange={onToggleDebugMode} />
    </Modal>
  );
}
