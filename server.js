const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = __dirname;
const ENV_PATH = path.join(ROOT_DIR, '.env');

const DEFAULT_JQL = {
  SEJ: 'project = SEJ ORDER BY Rank ASC',
  PEJ: 'project = PEJ ORDER BY Rank ASC',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

loadEnvFile();

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parsePort(process.env.PORT || '8001');

let sprintDashboardCache = null;
let sprintDashboardSyncPromise = null;
let scheduledTimer = null;

const MAX_TIMEOUT_MS = 2_147_483_647;
const SCHEDULE_INTERVAL_DAYS = 14;
const SCHEDULE_START_DATE = new Date(2026, 5, 12, 11, 30, 0, 0);

function loadEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return;
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

function getConfig() {
  return {
    baseUrl: cleanBaseUrl(process.env.JIRA_BASE_URL || ''),
    email: process.env.JIRA_EMAIL || '',
    apiToken: process.env.JIRA_API_TOKEN || '',
    jql: {
      SEJ: process.env.JIRA_JQL_SEJ || DEFAULT_JQL.SEJ,
      PEJ: process.env.JIRA_JQL_PEJ || DEFAULT_JQL.PEJ,
    },
    syncUsername: process.env.SYNC_USERNAME || '',
    syncPassword: process.env.SYNC_PASSWORD || '',
  };
}

function cleanBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT value: ${value}`);
  }
  return port;
}

function getMissingConfig(config) {
  const missing = [];
  if (!config.baseUrl) missing.push('JIRA_BASE_URL');
  if (!config.email) missing.push('JIRA_EMAIL');
  if (!config.apiToken) missing.push('JIRA_API_TOKEN');
  if (!config.jql.SEJ) missing.push('JIRA_JQL_SEJ');
  if (!config.jql.PEJ) missing.push('JIRA_JQL_PEJ');
  return missing;
}

function getMissingSyncConfig(config) {
  const missing = [];
  if (!config.syncUsername) missing.push('SYNC_USERNAME');
  if (!config.syncPassword) missing.push('SYNC_PASSWORD');
  return missing;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function collectJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('Request body is too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function getAuthHeader(config) {
  return `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`;
}

async function jiraRequest(config, endpoint, options = {}) {
  const response = await fetch(`${config.baseUrl}${endpoint}`, {
    ...options,
    headers: {
      Authorization: getAuthHeader(config),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_err) {
      payload = { message: text };
    }
  }

  if (!response.ok) {
    const detail =
      payload && (payload.errorMessages || payload.errors || payload.message)
        ? JSON.stringify(payload.errorMessages || payload.errors || payload.message)
        : response.statusText;
    const error = new Error(`Jira request failed (${response.status}): ${detail}`);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }

  return payload || {};
}

function pickFieldId(fieldByName, envName, names) {
  const envValue = process.env[envName];
  if (envValue) return envValue;
  for (const name of names) {
    if (fieldByName.has(name.toLowerCase())) return fieldByName.get(name.toLowerCase());
  }
  return '';
}

async function discoverFields(config) {
  const fields = await jiraRequest(config, '/rest/api/3/field');
  const fieldByName = new Map();
  for (const field of fields) {
    if (field && field.name && field.id) fieldByName.set(field.name.toLowerCase(), field.id);
  }

  return {
    Sprint: pickFieldId(fieldByName, 'JIRA_FIELD_SPRINT', ['Sprint', 'Custom field (Sprint)']),
    'Story Points': pickFieldId(fieldByName, 'JIRA_FIELD_STORY_POINTS', [
      'Story Points',
      'Story point estimate',
      'Custom field (Story Points)',
    ]),
    'Due Date': pickFieldId(fieldByName, 'JIRA_FIELD_DUE_DATE', [
      'Due Date',
      'Due date',
      'Custom field (Due Date)',
    ]),
    'Product Manager': pickFieldId(fieldByName, 'JIRA_FIELD_PRODUCT_MANAGER', [
      'Product Manager',
      'Custom field (Product Manager)',
    ]),
    'University Name': pickFieldId(fieldByName, 'JIRA_FIELD_UNIVERSITY_NAME', [
      'University Name',
      'Custom field (University Name)',
    ]),
    'Skill Set': pickFieldId(fieldByName, 'JIRA_FIELD_SKILL_SET', [
      'Skill Set',
      'Custom field (Skill Set)',
    ]),
    'Test Case Doc': pickFieldId(fieldByName, 'JIRA_FIELD_TEST_CASE_DOC', [
      'Test Case Doc',
      'Test Case Docs',
      'Custom field (Test Case Doc)',
    ]),
  };
}

function getSearchFields(fieldMap) {
  const baseFields = ['issuetype', 'summary', 'parent', 'status', 'assignee', 'project'];
  const customFields = Object.values(fieldMap).filter(Boolean);
  return [...new Set([...baseFields, ...customFields])];
}

async function fetchIssuesEnhanced(config, jql, fields) {
  const issues = [];
  let nextPageToken = '';

  do {
    const params = new URLSearchParams();
    params.set('jql', jql);
    params.set('maxResults', '100');
    params.set('fields', fields.join(','));
    if (nextPageToken) params.set('nextPageToken', nextPageToken);

    const payload = await jiraRequest(config, `/rest/api/3/search/jql?${params.toString()}`);
    issues.push(...(payload.issues || []));
    nextPageToken = payload.nextPageToken || '';
    if (payload.isLast === true) nextPageToken = '';
  } while (nextPageToken);

  return issues;
}

async function fetchIssuesClassic(config, jql, fields) {
  const issues = [];
  let startAt = 0;
  let total = 0;

  do {
    const payload = await jiraRequest(config, '/rest/api/3/search', {
      method: 'POST',
      body: JSON.stringify({
        jql,
        startAt,
        maxResults: 100,
        fields,
      }),
    });
    const pageIssues = payload.issues || [];
    issues.push(...pageIssues);
    total = Number(payload.total || issues.length);
    startAt += pageIssues.length;
    if (pageIssues.length === 0) break;
  } while (issues.length < total);

  return issues;
}

async function fetchIssues(config, jql, fields) {
  try {
    return await fetchIssuesEnhanced(config, jql, fields);
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 405) {
      return fetchIssuesClassic(config, jql, fields);
    }
    throw err;
  }
}

function extractDisplayValue(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(extractDisplayValue).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    if (value.displayName) return String(value.displayName);
    if (value.name) return String(value.name);
    if (value.value) return String(value.value);
    if (value.title) return String(value.title);
    if (value.key) return String(value.key);
    if (value.content) return extractAtlassianDoc(value);
  }
  return '';
}

function extractAtlassianDoc(node) {
  const parts = [];
  const visit = (item) => {
    if (!item) return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (item.text) parts.push(item.text);
    if (item.content) visit(item.content);
  };
  visit(node.content);
  return parts.join(' ').trim();
}

function getMappedField(fields, fieldMap, name) {
  const id = fieldMap[name];
  return id ? fields[id] : '';
}

function mapIssueToRecord(issue, fieldMap) {
  const fields = issue.fields || {};
  const parent = fields.parent || {};
  const parentFields = parent.fields || {};
  const parentSummary = parentFields.summary || parent.summary || parent.key || '';

  return {
    'Issue Type': extractDisplayValue(fields.issuetype && (fields.issuetype.name || fields.issuetype)),
    'Issue key': issue.key || '',
    'Parent key': parent.key || '',
    'Parent summary': extractDisplayValue(parentSummary),
    Parent: extractDisplayValue(parentSummary),
    Summary: extractDisplayValue(fields.summary),
    Sprint: extractDisplayValue(getMappedField(fields, fieldMap, 'Sprint')),
    Status: extractDisplayValue(fields.status && (fields.status.name || fields.status)),
    Assignee: extractDisplayValue(fields.assignee),
    'Custom field (Story Points)': extractDisplayValue(getMappedField(fields, fieldMap, 'Story Points')),
    'Custom field (Due Date)': extractDisplayValue(getMappedField(fields, fieldMap, 'Due Date')),
    'Custom field (Product Manager)': extractDisplayValue(getMappedField(fields, fieldMap, 'Product Manager')),
    'Custom field (University Name)': extractDisplayValue(getMappedField(fields, fieldMap, 'University Name')),
    'Custom field (Skill Set)': extractDisplayValue(getMappedField(fields, fieldMap, 'Skill Set')),
    'Custom field (Test Case Doc)': extractDisplayValue(getMappedField(fields, fieldMap, 'Test Case Doc')),
  };
}

function getNextScheduledSyncDate(fromDate = new Date()) {
  const next = new Date(SCHEDULE_START_DATE);
  while (next <= fromDate) {
    next.setDate(next.getDate() + SCHEDULE_INTERVAL_DAYS);
    next.setHours(11, 30, 0, 0);
  }
  return next;
}

function scheduleNextJiraSync() {
  if (scheduledTimer) clearTimeout(scheduledTimer);
  const nextRun = getNextScheduledSyncDate();
  const runScheduledSync = async () => {
    try {
      await syncSprintDashboard('scheduled');
    } catch (err) {
      console.error('Scheduled Jira sync failed:', err.message);
    } finally {
      scheduleNextJiraSync();
    }
  };
  const scheduleWait = () => {
    const remaining = nextRun.getTime() - Date.now();
    if (remaining > MAX_TIMEOUT_MS) {
      scheduledTimer = setTimeout(scheduleWait, MAX_TIMEOUT_MS);
      if (typeof scheduledTimer.unref === 'function') scheduledTimer.unref();
      return;
    }
    scheduledTimer = setTimeout(runScheduledSync, Math.max(1000, remaining));
    if (typeof scheduledTimer.unref === 'function') scheduledTimer.unref();
  };
  scheduleWait();
  return nextRun;
}

async function syncSprintDashboard(syncReason = 'manual') {
  if (sprintDashboardSyncPromise) return sprintDashboardSyncPromise;

  sprintDashboardSyncPromise = (async () => {
    const config = getConfig();
    const missing = getMissingConfig(config);
    if (missing.length) {
      const response = {
        source: 'jira',
        configured: false,
        error: `Missing Jira configuration: ${missing.join(', ')}`,
        details: { missing },
        records: null,
        nextScheduledSyncAt: getNextScheduledSyncDate().toISOString(),
      };
      sprintDashboardCache = response;
      return response;
    }

    const fieldMap = await discoverFields(config);
    const fields = getSearchFields(fieldMap);
    const warnings = [];
    for (const [label, fieldId] of Object.entries(fieldMap)) {
      if (!fieldId) warnings.push(`Could not auto-detect Jira field: ${label}`);
    }

    const records = {};
    for (const source of ['SEJ', 'PEJ']) {
      const issues = await fetchIssues(config, config.jql[source], fields);
      records[source] = issues.map((issue) => mapIssueToRecord(issue, fieldMap));
    }

    const response = {
      source: 'jira',
      configured: true,
      generatedAt: new Date().toISOString(),
      total: (records.SEJ || []).length + (records.PEJ || []).length,
      totals: {
        SEJ: (records.SEJ || []).length,
        PEJ: (records.PEJ || []).length,
      },
      jql: config.jql,
      records,
      warnings,
      syncReason,
      nextScheduledSyncAt: getNextScheduledSyncDate().toISOString(),
    };
    sprintDashboardCache = response;
    return response;
  })();

  try {
    return await sprintDashboardSyncPromise;
  } finally {
    sprintDashboardSyncPromise = null;
  }
}

async function handleGetSprintDashboard(_req, res) {
  if (!sprintDashboardCache) {
    await syncSprintDashboard('startup');
  }
  sendJson(res, sprintDashboardCache && sprintDashboardCache.configured === false ? 503 : 200, sprintDashboardCache);
}

async function handlePostSprintDashboardSync(req, res) {
  let body;
  try {
    body = await collectJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const config = getConfig();
  const missingSyncConfig = getMissingSyncConfig(config);
  if (missingSyncConfig.length) {
    return sendJson(res, 503, {
      error: `Missing sync configuration: ${missingSyncConfig.join(', ')}`,
      details: { missing: missingSyncConfig },
    });
  }

  if (body.username !== config.syncUsername || body.password !== config.syncPassword) {
    return sendJson(res, 401, { error: 'Invalid sync username or password' });
  }

  try {
    const payload = await syncSprintDashboard('manual');
    sendJson(res, payload.configured === false ? 503 : 200, payload);
  } catch (err) {
    const fallback = {
      source: 'jira',
      configured: true,
      error: err.message,
      records: null,
      lastSuccessfulSync: sprintDashboardCache && sprintDashboardCache.generatedAt,
      nextScheduledSyncAt: getNextScheduledSyncDate().toISOString(),
    };
    sendJson(res, 502, fallback);
  }
}

function handleHealthCheck(req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(JSON.stringify({ status: 'ok' }));
}

function serveStatic(req, res) {
  const rawPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const relativePath = rawPath === '/' ? '/index.html' : rawPath;
  const filePath = path.normalize(path.join(ROOT_DIR, relativePath));
  const relativeFilePath = path.relative(ROOT_DIR, filePath);
  const pathSegments = relativeFilePath.split(path.sep);

  if (
    relativeFilePath.startsWith('..') ||
    path.isAbsolute(relativeFilePath) ||
    pathSegments.some((segment) => segment.startsWith('.'))
  ) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/healthz') {
      handleHealthCheck(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/sprint-dashboard') {
      await handleGetSprintDashboard(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/sprint-dashboard/sync') {
      await handlePostSprintDashboardSync(req, res);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res);
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  const nextSync = scheduleNextJiraSync();
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Sprint Dashboard server running at http://${displayHost}:${PORT}`);
  console.log(`Next scheduled Jira sync: ${nextSync.toLocaleString()}`);
});

function shutdown(signal) {
  console.log(`${signal} received. Shutting down Sprint Dashboard server...`);
  if (scheduledTimer) clearTimeout(scheduledTimer);
  server.close((err) => {
    if (err) {
      console.error('Error while shutting down server:', err);
      process.exit(1);
    }
    process.exit(0);
  });
  const forceExitTimer = setTimeout(() => process.exit(1), 10_000);
  if (typeof forceExitTimer.unref === 'function') forceExitTimer.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
