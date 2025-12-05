# Changelog

All notable changes to BluePDM will be documented in this file.

## [0.10.2] - 2025-12-05

### Added
- Full macOS compatibility for vault paths and file operations
- Platform-aware UI text ("Reveal in Finder" on macOS, "Show in Explorer" on Windows)

### Fixed
- Title bar padding now correctly positions for macOS window buttons (left side)
- Vault folders now created in `~/Documents/BluePDM/` on macOS instead of `C:\BluePDM\`
- File downloads now create proper folder hierarchy on macOS (was creating flat structure with backslashes in filenames)
- Path separators now use `/` on macOS and `\` on Windows throughout the app
- About page version now dynamically reads from package.json instead of hardcoded value

### Changed
- Context menu shows "Reveal in Finder" on macOS, "Show in Explorer" on Windows

## [0.10.1] - 2025-12-05

### Fixed
- Supabase client no longer crashes when credentials are not configured (graceful fallback)
- GitHub Actions workflow now includes Supabase secrets for CI/CD builds

## [0.10.0] - 2025-06-05

### Added
- Native file drag-and-drop to Windows Explorer (copies actual files, not shortcuts)
- Custom drag preview showing file icon and name
- Vault header inline badges: checkout count, cloud files count, user avatars
- Download button in vault header for cloud files
- Cloud file count badges inline with folder names
- Right-click context menu to disconnect vaults from sidebar
- Pin icon replaced star icon for pinned items

### Fixed
- Delete from server now shows proper confirmation dialog
- Cloud-only folders show grey icons (not green) in both FileBrowser and ExplorerView
- Clicking vault name in explorer now navigates to root folder
- Vault disconnect properly clears UI state and shows welcome screen
- Files now reload correctly after reconnecting to a vault

### Changed
- Avatars in FileBrowser positioned before inline action buttons
- Download arrow moved to right of cloud count in explorer
- Vault header download button slightly visible (not hidden until hover)
- Lock count badge moved before cloud count in vault header

## [0.7.0] - 2024-12-04

### Added
- SolidWorks file preview with embedded thumbnail extraction from .sldprt, .sldasm, .slddrw files
- Settings → Preferences panel with preview options (thumbnail vs external eDrawings)
- Lowercase extensions display setting (default: on) - shows .sldprt instead of .SLDPRT
- Explorer view file selection now shows details in bottom panel
- PDF preview in the Preview tab
- Image preview support (PNG, JPG, GIF, BMP, WebP, SVG)
- Native eDrawings module scaffolding for future embedded 3D preview

### Changed
- Preview tab is now the default tab in the details panel
- File extensions displayed consistently across all views based on user preference

### Fixed
- Bottom panel resize functionality
- Extension display consistency across Name column, Type column, and Explorer view

## [0.6.0] - 2024-12-04

### Added
- File type icons for STEP, PDF, images, spreadsheets, archives, PCB, schematics, libraries, and code files
- Distinct colors for each file type (amber assemblies, sky drawings, red schematics, violet libraries, etc.)
- Vaults table type definitions for TypeScript

### Fixed
- Startup double-loading issue (files no longer load twice with "add diff spam")
- Added loading state while waiting for organization to load
- Fixed pinned file icons not showing correctly for .slddrw and other file types
- Fixed extension parsing for pinned items (missing dot prefix)

### Changed
- Assembly icon now amber colored (stands out from other blues)
- Drawing icon now uses FilePen for a more artistic look

## [1.1.2] - 2024-12-03

### Fixed
- App not launching on some Windows machines (window now shows after 5s fallback)
- Added startup logging for debugging launch issues
- Added crash and error handlers for renderer process

## [1.1.1] - 2024-12-02

### Fixed
- Build configuration improvements
- Simplified release artifacts (single universal macOS build)

## [1.1.0] - 2024-12-01

### Added
- File save/load functionality for tube configurations
- Menu bar with File operations

### Changed
- Improved UI layout and styling

## [1.0.0] - 2024-11-30

### Added
- Initial release
- Pressure vessel dimension optimizer for underwater applications
- Interactive 3D cylinder visualization
- Material selection (various metals and alloys)
- Parameter inputs for depth, safety factor, and dimensions
- Results table with optimized calculations
- VSCode-inspired dark theme UI

