# BluePDM

Open source Product Data Management for engineering teams. Built with Electron, React, TypeScript, and Supabase.

![BluePDM](https://img.shields.io/badge/version-0.10.2-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- 🔐 **Google OAuth** with automatic org assignment by email domain
- 📁 **VS Code-style file browser** with customizable columns
- 🔒 **Check In / Check Out** with exclusive file locks
- 📊 **File state management** (WIP, In Review, Released, Obsolete)
- 🔄 **Version tracking** with instant rollback capability
- 👁️ **SolidWorks preview** with embedded thumbnail extraction
- 📄 **PDF & image preview** directly in the app
- 🔗 **Where-used analysis** for assembly references
- ☁️ **Cloud sync** via Supabase for team collaboration
- 🌐 **Offline mode** for local-only file management

## Optimized for SolidWorks & CAD

BluePDM is designed specifically for engineering file management:

| File Type | Extensions | Features |
|-----------|------------|----------|
| **SolidWorks** | `.sldprt`, `.sldasm`, `.slddrw` | Thumbnail preview, eDrawings integration |
| **CAD Exchange** | `.step`, `.stp`, `.iges`, `.igs` | Universal format support |
| **Mesh** | `.stl`, `.3mf`, `.obj` | 3D printing ready |
| **Documents** | `.pdf`, `.xlsx`, `.csv` | In-app preview |
| **Electronics** | `.sch`, `.brd`, `.kicad_pcb` | PCB design files |
| **Archives** | `.zip`, `.rar`, `.7z` | Compressed packages |

## Quick Start

### Prerequisites

- Node.js 18+
- A Supabase project (free tier works great)

### Installation

```bash
# Clone the repo
git clone https://github.com/bluerobotics/blue-pdm.git
cd blue-pdm

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Add your Supabase credentials to .env
```

### Supabase Setup

1. Create a new Supabase project at [supabase.com](https://supabase.com)
2. Go to SQL Editor and run the schema from `supabase/schema.sql`
3. Enable Google OAuth in Authentication > Providers
4. Copy your project URL and anon key to `.env`

### Development

```bash
# Start the dev server (Vite + Electron)
npm run electron:dev
```

### Build

```bash
# Build for production
npm run build
```

## Screenshots

![BluePDM Screenshot](assets/screenshot.png)

## Architecture

### Technology Stack

- **Frontend**: React 18, TypeScript, Tailwind CSS
- **Desktop**: Electron 28
- **State**: Zustand with persistence
- **Backend**: Supabase (PostgreSQL, Auth, Storage)
- **Icons**: Lucide React

### File Storage

- **Local Vault**: Files are stored in platform-specific locations:
  - **Windows**: `C:\BluePDM\{vault-name}`
  - **macOS**: `~/Documents/BluePDM/{vault-name}`
  - **Linux**: `~/BluePDM/{vault-name}`
- **Cloud Sync**: File content synced to Supabase Storage
- **Metadata**: File state, locks, and versions in PostgreSQL
- **Real-time**: Instant sync of locks and state changes

### Database Schema

```
organizations    - Companies/teams with email domain matching
users           - Engineers with org membership and roles  
vaults          - Isolated file repositories per team
files           - File metadata, state, and checkout status
file_versions   - Complete version history
file_references - Assembly/part relationships (BOM)
activity        - Audit log of all actions
```

## Configuration

### Organization Setup

Organizations are automatically assigned based on email domain:

```sql
INSERT INTO organizations (name, slug, email_domains, revision_scheme)
VALUES ('Your Company', 'yourcompany', ARRAY['yourcompany.com'], 'letter');
```

### Preferences

Access Settings → Preferences to configure:
- **SolidWorks Preview**: Embedded thumbnail or external eDrawings
- **Lowercase Extensions**: Display `.sldprt` instead of `.SLDPRT`

## Roadmap

- [x] SolidWorks thumbnail preview
- [x] PDF and image preview
- [x] Multi-vault support
- [x] Customizable file browser columns
- [ ] SolidWorks add-in for direct integration
- [ ] Automatic BOM extraction from assemblies
- [ ] Approval workflows for releases
- [ ] Email notifications
- [ ] Embedded eDrawings 3D viewer
- [ ] Batch operations
- [ ] Advanced search with filters

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

## License

MIT License - see [LICENSE](LICENSE) for details.

---

Made with 💙 by [Blue Robotics](https://bluerobotics.com)
