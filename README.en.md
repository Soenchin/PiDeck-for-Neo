# PiDeck for NeoNisch

[中文文档](README.md)

![Status](https://img.shields.io/badge/status-experimental-orange)
![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Electron](https://img.shields.io/badge/Electron-38-47848f)
![React](https://img.shields.io/badge/React-19-61dafb)
![Version](https://img.shields.io/badge/version-0.6.5-green)

> **The PiDeck branch dedicated to NeoNisch (NN).**
>
> A local AI workspace built for the long-term collaboration between Soen and NeoNisch, combining pi's multi-session capabilities with NN's visual identity, desktop pet, agent rooms, and collaboration workflow.

PiDeck for NeoNisch is forked from [PiDeck](https://github.com/ayuayue/PiDeck) and continuously customized around the NeoNisch (NN) workflow. It is not intended to be a generic PiDeck distribution. The interface, startup experience, desktop pet, agent rooms, session continuity, and task-artifact views are shaped around how Soen and NN actually work together.

PiDeck still runs agents through `pi --mode rpc`. NeoNisch customization belongs to the desktop collaboration layer and user experience; it does not replace pi's native runtime for models, tools, or sessions.

---

## Branch Highlights

The main directions of this fork since diverging from upstream PiDeck are:

- **NeoNisch branding and visual system**: NN-specific title-bar branding, wordmark, Logo A color transition, dark startup screen, and glass-style workspace theme turn PiDeck into a dedicated NN workbench.
- **NN desktop pet experience**: An integrated NeoNisch desktop pet with drag interaction and patrol-direction handling, so the agent experience is not confined to a chat window.
- **Neo / ROCKET dual-agent room**: A dual-agent room for NN collaboration scenarios, allowing different roles, task perspectives, or collaboration partners to be separated clearly.
- **Session continuity for long-running collaboration**: Improved recovery of post-compaction history, cache diagnostics, automatic session titles, and unread states for background sessions help prevent context breaks during extended work.
- **Cross-session question indicator**: When an agent is waiting for the owner's answer, the sidebar keeps a stable **Question** status. Switching to another session does not require a modal, sound, or flashing notification.
- **Task-artifact preview**: Completed runs show a compact card for the task artifacts and modification summary, making it easier to confirm what NN has just finished.
- **NeoNisch interaction polish**: Session controls, composer behavior, stop handling, file drawer, Git area, desktop-pet dragging, and startup flow are continuously refined around frequent NN collaboration.
- **Proxy and model connection diagnostics**: Separate pi-agent and desktop proxy settings, together with connection testing, make direct, proxied, and provider-specific connection issues easier to diagnose.
- **Automatic update scheduling removed**: This fork does not check for updates five seconds after startup or on a background timer. Manual update checking remains available from Settings, so active NN sessions are not interrupted.
- **Dedicated Git workspace experience**: Working-tree, commit-history, and remote information are integrated into the existing session workbench without replacing the NeoNisch custom interface wholesale.

Upstream PiDeck changes are not merged blindly. Each update is reviewed for conflicts and practical value before selected pieces are integrated, protecting the existing NeoNisch collaboration experience.

---

## Screenshots

### Workspace & Conversation

![Workspace overview](docs/images/overview.png)

NeoNisch workspace overview: branded desktop layout, Markdown rendering and streaming output, activity flow, tool-call details, model and thinking controls, cache status, Git branch information, and session controls.

### Configuration Management

![Configuration management](docs/images/config.png)

Configuration management for Models, Auth, Settings, and raw JSON editing. Saved configuration can be applied after restarting an agent when necessary.

### Slash Commands & Session History

![Slash commands and session history](docs/images/slash-commands.png)

The slash-command suggestion panel and session-history drawer for quickly browsing and restoring conversations in NN's long-running workflow.

### File Tree & Session Actions

![File tree and session actions](docs/images/files.png)

Project file tree, file references, session modification summary, and session context actions.

> These screenshots are temporary and will be replaced with new captures that better show the NeoNisch visual theme, desktop pet, and Neo / ROCKET dual-agent room.

---

## Requirements

- Node.js 20+
- npm
- `pi` command available in the system `PATH`
- pi provider, authentication, or API key configuration completed

Verify that pi is available:

```bash
pi --version
pi --mode rpc
```

---

## Development Commands

After installing dependencies, use the following commands for development and verification:

| Command | Description |
|---|---|
| `npm run dev` | Start Electron development mode |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run build` | Build Renderer, Preload, and Main bundles |
| `npm run dist` | Package for the current platform |
| `npm run dist:win` | Package for Windows (NSIS, portable, zip) |
| `npm run dist:mac` | Package for macOS (DMG, zip) |
| `npm run dist:linux` | Package for Linux (AppImage, deb, tar.gz) |
| `npm run make-icon` | Generate icon assets at `build/icon.svg` |

### Browser Preview Mode

Open `http://localhost:5173/` directly in a browser for layout and responsive checks. The renderer falls back to mock data when `window.piDesktop` is unavailable, which is useful for CSS and UI work without Electron. Real IPC features such as agents, sessions, and file operations still require the Electron app.

---

## Security

This app starts local `pi` processes and exposes limited file operations through Electron IPC. Only run trusted source code.

By default, the app sends an anonymous, low-frequency `app_heartbeat` to understand version distribution, platform compatibility, and active installations. It can be disabled in Settings. The app does not collect project paths, code, message content, session content, or file names, and it does not upload files. The third-party analytics service receives request metadata.

The pi-agent process proxy and desktop model-fetch/test proxy can be configured separately. External links opened in the system browser still follow the browser and system network settings.

## License

This fork is distributed under the [GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html) (AGPL-3.0-only).

PiDeck for NeoNisch is forked from upstream PiDeck. The original upstream MIT license and copyright information are preserved in [`LICENSE-MIT`](LICENSE-MIT); new and modified code in this fork is released under AGPL-3.0-only.
