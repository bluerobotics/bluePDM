# BluePDM

Product Data Management for engineering teams. Built with Electron, React, and Supabase.

![BluePDM Screenshot](assets/screenshot.png)

[![Version](https://img.shields.io/github/v/release/bluerobotics/blue-pdm)](https://github.com/bluerobotics/blue-pdm/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/bluerobotics/blue-pdm/release.yml)](https://github.com/bluerobotics/blue-pdm/actions)
[![Downloads](https://img.shields.io/github/downloads/bluerobotics/blue-pdm/total)](https://github.com/bluerobotics/blue-pdm/releases)
[![License](https://img.shields.io/github/license/bluerobotics/blue-pdm)](LICENSE)

## Features

- **Check In / Check Out** with exclusive file locking
- **Version control** with full history and rollback
- **File state management** (WIP, In Review, Released, Obsolete)
- **SolidWorks integration** with thumbnail previews
- **Where-used analysis** for tracking assembly references
- **Cloud sync** via Supabase with real-time collaboration
- **Offline mode** for local-only workflows

## Supported Formats

| Category | Extensions |
|----------|------------|
| SolidWorks | `.sldprt`, `.sldasm`, `.slddrw` |
| CAD Exchange | `.step`, `.stp`, `.iges`, `.igs`, `.stl` |
| Documents | `.pdf`, `.xlsx`, `.csv` |
| Electronics | `.sch`, `.brd`, `.kicad_pcb` |

## Installation

Download the latest release for your platform from the [releases page](https://github.com/bluerobotics/blue-pdm/releases).

### Building from Source

```bash
git clone https://github.com/bluerobotics/blue-pdm.git
cd blue-pdm
npm install
npm run build
```

### Supabase Setup

1. **Create a Supabase project** at [supabase.com](https://supabase.com)

2. **Run the database schema:**
   - Go to SQL Editor in your Supabase dashboard
   - Copy and run the contents of `supabase/schema.sql`

3. **Set up Google OAuth:**
   - Go to Authentication → Providers → Google
   - Enable Google provider
   - Add your Google OAuth credentials (from [Google Cloud Console](https://console.cloud.google.com/apis/credentials))
   - Add `http://localhost` to Redirect URLs (for Electron app)

4. **Create a storage bucket:**
   - Go to Storage → New Bucket
   - Name it `vault`
   - Set to **Private** (not public)
   - Policies are created automatically by the schema

5. **Create your organization** (one-time admin setup):
   ```sql
   INSERT INTO organizations (name, slug, email_domains)
   VALUES ('Your Company', 'your-company', ARRAY['yourcompany.com']);
   ```
   Users with matching email domains will auto-join on sign-in.
   Vaults can then be created through the app (Settings → Organization).

6. **Verify the trigger exists:**
   ```sql
   SELECT tgname FROM pg_trigger WHERE tgname = 'on_auth_user_created';
   ```
   If empty, the trigger didn't attach. Re-run the trigger creation from `schema.sql`.

### Configuration (Optional)

For development, create a `.env` file:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

For production builds, users configure Supabase credentials through the app's setup screen on first launch.

## File Storage

Local vaults are stored in platform-specific locations:

| Platform | Path |
|----------|------|
| Windows | `C:\BluePDM\{vault-name}` |
| macOS | `~/Documents/BluePDM/{vault-name}` |
| Linux | `~/BluePDM/{vault-name}` |

## Tech Stack

- Electron 34
- React 19
- TypeScript
- Tailwind CSS
- Zustand
- Supabase (PostgreSQL, Auth, Storage)

## License

MIT License - see [LICENSE](LICENSE) for details.

---

[Blue Robotics](https://bluerobotics.com)
