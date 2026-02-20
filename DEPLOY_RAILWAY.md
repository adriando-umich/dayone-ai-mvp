# Deploy DayOne.ai MVP on Railway (Fast Path)

## 1) Push code to GitHub
If this repo is not on GitHub yet:

```powershell
cd C:\Personal\Hackathon
git add .
git commit -m "chore: dayone branding + railway deploy prep"
git branch -M main
git remote add origin https://github.com/<your-user>/<your-repo>.git
git push -u origin main
```

If `.env` is tracked, untrack it before pushing:

```powershell
git rm --cached .env
git commit -m "chore: stop tracking .env"
git push
```

## 2) Create Railway service
1. Go to Railway -> `New Project` -> `Deploy from GitHub Repo`.
2. Select this repo.
3. In service settings:
- Start command: `npm start`
- Node version: `>=20` (already in `package.json`)

## 3) Set Railway environment variables
Minimum:
- `OPENAI_API_KEY`
- `OPENAI_MODEL=gpt-4o-mini`
- `OPENAI_ROUTER_MODEL=gpt-4o-mini`
- `OPENAI_HUMANIZER_MODEL=gpt-4o-mini`
- `ENABLE_AI_TURN_ROUTER=1`
- `ENABLE_AI_HUMANIZER=1`
- `STRICT_AI_DECISIONS=1`
- `USE_N8N_DIRECT_AGENTS=0`
- `PORT=3000`

Important for cloud callback:
- `PUBLIC_BASE_URL=https://<your-railway-domain>`

If you use n8n:
- `N8N_START_URL=https://<your-n8n>/webhook/sim/v2a/session/start`
- `N8N_EVENT_URL=https://<your-n8n>/webhook/sim/v2a/session/event`
- `N8N_AGENT_QA_URL=https://<your-n8n>/webhook/sim/v2a/agent/qa`
- `N8N_AGENT_BA_URL=https://<your-n8n>/webhook/sim/v2a/agent/ba`
- `N8N_AGENT_TECHLEAD_URL=https://<your-n8n>/webhook/sim/v2a/agent/techlead`

## 4) Verify after deploy
1. Open `https://<your-railway-domain>/healthz` -> expect `{ "status": "ok" }`.
2. Open app root `/`.
3. Start a simulation and confirm:
- timer starts
- QA/BA/TL messages appear
- submit patch works

## 5) MVP caveats
- `recordings/` in Railway container is ephemeral (not durable storage).
- For production persistence, upload recordings to S3/R2 instead of local disk.
