import { useEffect, useRef, useState } from 'react';

import type { WorkspaceFolder } from '../hooks/useExtensionMessages.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
import { Dropdown, DropdownItem } from './ui/Dropdown.js';

interface BottomToolbarProps {
  isEditMode: boolean;
  onOpenClaude: () => void;
  onToggleEditMode: () => void;
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
  workspaceFolders: WorkspaceFolder[];
  /** Whether the connected provider can launch real office consoles
   *  (providerCapabilities.terminals). Shows "+ Agent" in the standalone browser. */
  consoleCapable: boolean;
  /** Opens the launch dialog (standalone browser's "+ Agent" flow). */
  onOpenLaunchDialog: () => void;
}

export function BottomToolbar({
  isEditMode,
  onOpenClaude,
  onToggleEditMode,
  isSettingsOpen,
  onToggleSettings,
  workspaceFolders,
  consoleCapable,
  onOpenLaunchDialog,
}: BottomToolbarProps) {
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);
  const [isBypassMenuOpen, setIsBypassMenuOpen] = useState(false);
  const folderPickerRef = useRef<HTMLDivElement>(null);
  const pendingBypassRef = useRef(false);
  // Close folder picker / bypass menu on outside click
  useEffect(() => {
    if (!isFolderPickerOpen && !isBypassMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(e.target as Node)) {
        setIsFolderPickerOpen(false);
        setIsBypassMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isFolderPickerOpen, isBypassMenuOpen]);

  const hasMultipleFolders = workspaceFolders.length > 1;

  const handleAgentClick = () => {
    // Standalone browser: no terminal to focus, so "+ Agent" always opens the
    // launch dialog (its own folder field + bypass checkbox), never the
    // VS Code folder-picker/bypass dropdowns below.
    if (isBrowserRuntime) {
      onOpenLaunchDialog();
      return;
    }
    setIsBypassMenuOpen(false);
    pendingBypassRef.current = false;
    if (hasMultipleFolders) {
      setIsFolderPickerOpen((v) => !v);
    } else {
      onOpenClaude();
    }
  };

  const handleAgentHover = () => {
    if (!isFolderPickerOpen) {
      setIsBypassMenuOpen(true);
    }
  };

  const handleAgentLeave = () => {
    if (!isFolderPickerOpen) {
      setIsBypassMenuOpen(false);
    }
  };

  const handleFolderSelect = (folder: WorkspaceFolder) => {
    setIsFolderPickerOpen(false);
    const bypassPermissions = pendingBypassRef.current;
    pendingBypassRef.current = false;
    transport.send({ type: 'launchAgent', folderPath: folder.path, bypassPermissions });
  };

  const handleBypassSelect = (bypassPermissions: boolean) => {
    setIsBypassMenuOpen(false);
    if (hasMultipleFolders) {
      pendingBypassRef.current = bypassPermissions;
      setIsFolderPickerOpen(true);
    } else {
      transport.send({ type: 'launchAgent', bypassPermissions });
    }
  };

  return (
    <div className="absolute bottom-10 left-10 z-20 flex items-center gap-4 pixel-panel p-4">
      {/* + Agent: in VS Code, launches a real terminal. In the standalone
          browser there is no terminal to interact with, so it only shows once
          the server reports it can start office consoles (providerCapabilities.terminals). */}
      {(!isBrowserRuntime || consoleCapable) && (
        <div
          ref={folderPickerRef}
          className="relative"
          onMouseEnter={isBrowserRuntime ? undefined : handleAgentHover}
          onMouseLeave={isBrowserRuntime ? undefined : handleAgentLeave}
        >
          <Button
            variant="accent"
            onClick={handleAgentClick}
            className={
              isFolderPickerOpen || isBypassMenuOpen
                ? 'bg-accent-bright'
                : 'bg-accent hover:bg-accent-bright'
            }
          >
            + Agent
          </Button>
          {/* The bypass/folder dropdowns are VS Code-only: the browser's launch
              dialog carries its own folder field and bypass checkbox. */}
          {!isBrowserRuntime && (
            <>
              <Dropdown isOpen={isBypassMenuOpen}>
                <DropdownItem onClick={() => handleBypassSelect(true)}>
                  Skip permissions mode <span className="text-2xs text-warning">⚠</span>
                </DropdownItem>
              </Dropdown>
              <Dropdown isOpen={isFolderPickerOpen} className="min-w-128">
                {workspaceFolders.map((folder) => (
                  <DropdownItem
                    key={folder.path}
                    onClick={() => handleFolderSelect(folder)}
                    className="text-base"
                  >
                    {folder.name}
                  </DropdownItem>
                ))}
              </Dropdown>
            </>
          )}
        </div>
      )}
      <Button
        variant={isEditMode ? 'active' : 'default'}
        onClick={onToggleEditMode}
        title="Edit office layout"
      >
        Layout
      </Button>
      <Button
        variant={isSettingsOpen ? 'active' : 'default'}
        onClick={onToggleSettings}
        title="Settings"
      >
        Settings
      </Button>
    </div>
  );
}
