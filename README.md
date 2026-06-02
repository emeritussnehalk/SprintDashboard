# Sprint Dashboard

Sprint Dashboard is a Node.js web service that serves `index.html` and syncs dashboard data from Jira.

## Local Setup

1. Copy `.env.example` to `.env`.
2. Fill in the Jira and sync credentials in `.env`.
3. Start the server:

```powershell
npm start
```

The app runs locally at `http://localhost:8001` unless `PORT` is changed.

## Deploy To Render

Create a Render Blueprint from this repository, or create a Web Service manually with:

- Runtime: `Node`
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/healthz`

Render will provide `PORT` automatically. Add these environment variables in Render:

- `JIRA_BASE_URL`
- `JIRA_EMAIL`
- `JIRA_API_TOKEN`
- `JIRA_JQL_SEJ`
- `JIRA_JQL_PEJ`
- `SYNC_USERNAME`
- `SYNC_PASSWORD`

Optional Jira field override variables are listed in `.env.example`. Leave them unset unless field auto-detection does not match your Jira setup.

The included `render.yaml` uses the free plan. If you need scheduled syncs to run reliably without waiting for traffic, switch the service to a paid plan so the instance does not sleep.
