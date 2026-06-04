# Deploy clinic-btn styles to VPS

## Goal
Deploy pushed commit `a4e4a52` (clinic button styles) to VPS 91.184.248.236 so changes are live and visually verifiable.

## Context
- VPS: Ubuntu 24.04, root, 91.184.248.236
- Project at `/opt/crypto-screener` on VPS
- Runs via `docker compose` (postgres, redis, server, client)
- Commit `a4e4a52` already pushed to `master` on GitHub
- Local dev server confirmed: Vite runs, no JS errors, but can't verify clinic-btn visually without backend

## Plan

### Step 1 — SSH into VPS, pull latest
```bash
ssh root@91.184.248.236
cd /opt/crypto-screener
git pull origin master
```

### Step 2 — Rebuild client container
```bash
docker compose build client
```

### Step 3 — Restart only client (server unchanged)
```bash
docker compose up -d client
```

### Step 4 — Verify
- Open `http://91.184.248.236:3001` in browser
- Check TopBar buttons: TF options, pagination, exchange filters → clinic-btn styles (transparent bg, glow borders)
- Check RightPanel tabs, DrawingToolsPanel, DensityMap threshold toggle, AlertStack buttons

## Files changed (already pushed)
- `client/src/index.css` — .clinic-btn* CSS classes
- `client/src/components/layout/TopBar.tsx`
- `client/src/components/layout/RightPanel.tsx`
- `client/src/components/charts/DrawingToolsPanel.tsx`
- `client/src/components/density/DensityMap.tsx`
- `client/src/components/alerts/AlertStack.tsx`
- `client/src/components/charts/ChartGrid.tsx`

## Risks
- `git pull` may fail if VPS repo has local changes — may need `git stash` or `git reset --hard`
- `docker compose build client` may take 1-2 min (npm install + vite build)
- If server API is down, client still shows AuthModal — but clinic-btn classes on TopBar won't render without data

## Open questions
- None. Straightforward deploy.
