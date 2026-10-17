# NOVA FORGE v1 — Galactic Workspace (Phase 6)

## Included
- `NOVA_FORGE.html`: standalone app; open in a modern browser.
- `web/`: PWA shell, manifest and service worker; installation/offline shell requires HTTPS or localhost.
- `android/`: starter Android WebView wrapper source.
- `IMPLEMENTATION_BLUEPRINT.md`: full product plan and practical constraints.

## Phase 2 workspace features
- IndexedDB persistence with migration from the previous localStorage prototype and localStorage fallback.
- Project folders, folder filtering, rename/duplicate/favorites, soft delete and restore from local trash.
- Checkpoints, bounded version history, undo to earlier saved files, and restore selected versions.
- ZIP export with ordinary uncompressed ZIP files; ZIP import supports stored entries and DEFLATE entries when the browser provides `DecompressionStream('deflate-raw')`.
- JSON backup/import remains available.
- Existing local code editor, sandboxed HTML preview and simulated build queue remain.

## Phase 3 — AI integration foundation
- Optional Node.js server in `server/`; serves the PWA and exposes `/api/health`, `/api/chat`, and `/api/plan`.
- Run with Node.js 20+: `cd server` then `node server.js`. Open `http://127.0.0.1:8787`.
- `server/.env.example` documents optional model settings. Copy it to `server/.env` and configure `NOVA_MODEL_BASE_URL`, `NOVA_MODEL_NAME`, and optionally `NOVA_MODEL_API_KEY` for an OpenAI-compatible model endpoint. Keep credentials server-side.
- Without a model configured, the API returns a labelled local planning fallback; it is not an AI model.
- AI Core can test the server connection, request chat responses, draft a plan, approve a plan, and copy a reviewed plan into the Create Project form. Approval does not execute or publish code.
- Run automated checks with `cd server && npm run check` (no npm packages are required).

## Phase 4 — local preflight and build diagnostics
- Build & Publish can run local static checks against the selected project files: project-type-aware entry point, title/viewport, relative references, image alt text, risky `eval` use, explicit HTTP links, large files, TODO markers, and common secret-like assignments. These checks do not execute code.
- Local job history distinguishes preflight checks from demo jobs; logs can be expanded, jobs rerun or removed, and history cleared with confirmation.
- The queue is not a real compiler or worker. APK compilation, deployment, container execution and remote job orchestration are not implemented.
- Run all checks with `npm run check --prefix server`.

## Phase 5 — isolated web build worker foundation
- `server/build-worker.js` adds a bounded in-memory queue for static HTML and Node-based web projects, with path/file/size validation, job status/log endpoints, cancellation, removal, and ZIP artifact downloads.
- Docker jobs use a separate container with memory, CPU and PID limits, dropped Linux capabilities, no-new-privileges, a read-only container root, a writable project mount, and network disabled by default. Project build scripts still execute as untrusted code inside that container.
- Enable only on a trusted private server by setting `NOVA_BUILD_WORKER_ENABLED=true` in `server/.env`; requires Docker Engine/CLI. Set `NOVA_BUILD_ALLOW_NETWORK=true` only if dependency downloads are necessary and approved. The default is disabled and local-only.
- In Build & Publish, choose **Build with server worker** after configuring the server URL in AI Core. Refresh server jobs to see status/logs and download successful ZIP artifacts.
- This is not a public multi-user service: there is no user authentication or tenant isolation yet. Do not expose it to the internet or bind it to a public interface without adding authentication, quotas, and deployment hardening.
- The worker does not compile Android APKs. It packages web output/source files as a ZIP; real Android SDK/Gradle workers are a later phase.

## Known limits
- ZIP import is text-oriented and skips oversized or unsupported entries; it is not a full binary-asset project manager yet.
- Version history is capped at 30 snapshots per project. Checkpoints and trash are local to this browser/device.
- No cross-device cloud sync, encrypted cloud vault, offline model weights, real hosting/deployment or actual APK compilation. The optional Phase 5 Docker worker is disabled by default and was not end-to-end tested here because Docker is unavailable in this environment.
- The preflight checker is a local static diagnostic, demo jobs are simulated, and the Phase 5 worker only runs when explicitly enabled on a server with Docker.
- Do not store API keys, passwords or release-signing secrets in this prototype.

## Android build
Open `android/` in Android Studio with JDK 17+ and Android SDK Platform 35. Sync Gradle and build the debug APK. Compilation and device testing have not been performed as part of this bundle; dependency resolution may need internet unless cached.


## Phase 6 — phone-first hosted workspace foundation
- `render.yaml` is a managed Node web-service blueprint intended for a free tier when available. It serves the PWA and API from one HTTPS origin, generates a `NOVA_ACCESS_TOKEN`, and keeps Docker builds disabled. It is deployment configuration, not a live deployment.
- `DEPLOY_FROM_PHONE.md` documents the provider setup and connection flow. Initial hosting still requires a repository and an account action in a mobile browser; ChatGPT has not created an account or deployed a live service.
- The API health endpoint is public and reports whether authentication is required. Chat, planning, build queue, job management, cancellation, and artifact routes require `Authorization: Bearer <NOVA_ACCESS_TOKEN>` when configured. The browser keeps the workspace token in `sessionStorage` for the current tab/session rather than project settings.
- Static HTML/CSS/JS projects can be packaged into ZIP artifacts without Docker. The packager does not execute user code. Projects containing `package.json` or requiring compilation are rejected unless a separate Docker worker is enabled on a compatible hardened server.
- The template deliberately configures no model key, no paid provider, and no automatic paid fallback. Static job state/artifacts are currently in memory and can be lost on service restart.
