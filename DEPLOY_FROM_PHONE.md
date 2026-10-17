# NOVA FORGE hosted workspace — phone-first deployment

This guide is designed for an Android phone browser. You do **not** need a computer, terminal, Docker, or a server you manage. The service runs on managed hosting. A public URL is real only after the provider reports the deployment as **Live** and the health endpoint responds successfully.

## What this deployment supports

- Hosts the NOVA FORGE PWA and API on one HTTPS service.
- Uses a workspace access token to protect chat, planning, build queue, cancellation, logs, and artifact endpoints. `/api/health` remains public for hosting health checks.
- Packages simple static HTML/CSS/JS projects into downloadable ZIP files without Docker and without executing project code.
- Keeps the Docker/container worker disabled. It does not compile APKs, run arbitrary npm builds, publish generated websites, or configure a real AI model.
- Uses the free service plan in the supplied configuration. Do not continue if a payment method or paid plan is required.

## Step 1 — create a repository from your phone

The connected GitHub account currently has no repository, so a repository must be created once before Render can deploy the app.

1. Download the [NOVA FORGE Phases 1–7 bundle](sandbox:/mnt/data/NOVA_FORGE_v1_bundle.zip) to your phone.
2. Open [GitHub](https://github.com/new) in your phone browser and sign in.
3. Create a repository named `nova-forge` (private is recommended). Do not add a README or other starter files if GitHub offers that option.
4. Open the new repository, choose **Add file → Upload files**, and upload `NOVA_FORGE_v1_bundle.zip` as one file. Commit the upload.

> If GitHub's mobile page does not show **Upload files**, open the browser menu and choose **Desktop site**, then retry. You only need to upload the ZIP; do not extract it on the phone.

## Step 2 — create the managed Render service

The connected Render account can create the service once the GitHub repository exists. Use these settings:

- **Name:** `nova-forge-workspace`
- **Runtime:** Node
- **Plan:** Free
- **Build command:** `unzip -o NOVA_FORGE_v1_bundle.zip && npm --prefix NOVA_FORGE_v1/server run check`
- **Start command:** `npm --prefix NOVA_FORGE_v1/server start`
- **Health check path:** `/api/health`

Environment variables:

- `NODE_ENV` = `production`
- `NOVA_HOST` = `0.0.0.0`
- `NOVA_STATIC_BUNDLE_ENABLED` = `true`
- `NOVA_BUILD_WORKER_ENABLED` = `false`
- `NOVA_ACCESS_TOKEN` = generate a strong random value and keep it private

The uploaded ZIP contains the project under the `NOVA_FORGE_v1/` directory, which is why the commands include that folder. If the host reports `unzip` is unavailable or fails the build, stop and share the error; do not switch to a paid plan to work around it.

## Step 3 — verify the deployment

1. Wait for Render to report the service as **Live** and copy the public `https://…onrender.com` URL.
2. Open `https://YOUR-SERVICE-URL/api/health`. Expect JSON with `ok: true`, `authRequired: true`, and `buildWorker.staticBundleEnabled: true`.
3. Open the root service URL and verify that NOVA FORGE loads.
4. In NOVA FORGE, open **AI Core**, enter the hosted service URL and workspace token, choose **Use token for this session**, then **Test connection**.
5. Create a small static website project and use **Build with server worker**. The result should be a ZIP artifact. This packages source; it does not publish the site.

## Important limits

- A repository upload or a created service is not proof of a successful deployment. Only report a live URL after the service is Live and the health endpoint passes.
- Build-job metadata and generated artifacts are stored in memory and can be lost when the service restarts. This is a prototype, not reliable production storage.
- The server uses a local planning/chat fallback until a compatible AI model endpoint is configured. No model API key is included by default.
- APK compilation, full React/Next.js compilation, automatic website publishing, persistent cloud projects, and background jobs that survive restarts are not implemented by this phase.
- Never put model keys, passwords, Android signing keys, or other secrets in the uploaded project files.
