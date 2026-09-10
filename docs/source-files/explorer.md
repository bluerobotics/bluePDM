# Explorer

The Explorer is your main interface for browsing and managing files in BluePLM.

## Interface Overview

The Explorer shows:
- **Connected Vaults** - Top-level containers you have access to
- **Folder Tree** - Navigate through directories
- **File List** - Files in the current location
- **Status Indicators** - Sync status, checkout state, modifications

## Connecting a Vault

Before you see files, you need to connect to a vault:

1. If no vaults are connected, you'll see the Welcome screen
2. Click **Connect** next to an available vault
3. BluePLM creates a local folder and syncs files

## File States

Files show different states based on their sync status:

| State | Meaning |
|-------|---------|
| Synced | Local and cloud versions match |
| Modified | Local changes not yet uploaded |
| Cloud Only | Exists on server, not downloaded locally |
| Outdated | Server has a newer version |
| Checked Out | Someone is actively editing |
| Moved | The file sits here on your disk, but the vault still records it at its old path |
| Moved Away | The vault still lists the file here, but on your disk it has moved elsewhere |

## Actions

### Download Files
Click the download button to fetch files that exist only in the cloud and are not yet on your
disk. It acts only on Cloud Only files, so a folder containing both Cloud Only and Outdated
files downloads just the ones you do not have.

### Get Latest
Click the update button, or choose **Get Latest** from the right-click menu, to replace files
you already have with a newer version from the server. It acts only on Outdated files.

### Resolve Moved Files
Moved and Moved Away are two views of the same file: one row where it actually is, one where the
vault still expects it. Choose **Resolve Moved Files…** from the right-click menu to pick which
side wins. **Update the Vault** writes the path on your disk to the server, and everyone else
picks up the new location on their next sync. **Restore Local Files** renames the files on your
disk back to the path the server already records, and writes nothing to the server.

Either direction skips files checked out by someone else unless you explicitly include them, and
skips any file whose destination is already occupied.

### Check Out
Before editing a file, check it out to lock it:
- Others see who has it locked
- Prevents conflicting edits

### Check In
When done editing, check in your changes:
- Uploads your modified file
- Releases the lock

### Multi-Select
Hold `Ctrl` (or `Cmd` on Mac) to select multiple files for batch operations.

## Pinned Folders

Pin frequently-used folders for quick access:
1. Right-click a folder
2. Select **Pin**
3. It appears in the Pinned section at the top

Drag pinned folders to reorder them.

## Context Menu

Right-click files/folders for additional options:
- Open in Explorer/Finder
- Rename
- Copy/Move
- Delete
- View History

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `F5` | Refresh |
| `Delete` | Move to trash |
| `F2` | Rename |
| `Ctrl+C` | Copy |
| `Ctrl+V` | Paste |

