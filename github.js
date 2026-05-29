// GitHub helpers: OAuth Device Flow + minimal REST calls.
//
// The Device Flow needs a registered GitHub OAuth App's client_id. Set it via
// `CLAWDOC_GITHUB_CLIENT_ID`. If unset, the UI falls back to "paste a personal
// access token" which works without any app registration.

const { createOAuthDeviceAuth } = require('@octokit/auth-oauth-device');
const { request } = require('@octokit/request');

const CLIENT_ID = process.env.CLAWDOC_GITHUB_CLIENT_ID || '';
const SCOPES = ['repo'];

// In-memory map of active device-flow sessions keyed by an opaque id we mint.
// Each entry stores the latest verification info and resolves with a token
// (or rejects) when the user completes / cancels the flow.
const sessions = new Map();

function deviceFlowAvailable() { return !!CLIENT_ID; }

function startDeviceFlow() {
  if (!CLIENT_ID) throw new Error('CLAWDOC_GITHUB_CLIENT_ID is not set');
  const id = 'df_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const session = { id, verification: null, token: null, error: null, done: false };

  const auth = createOAuthDeviceAuth({
    clientType: 'oauth-app',
    clientId: CLIENT_ID,
    scopes: SCOPES,
    onVerification(v) {
      session.verification = {
        user_code: v.user_code,
        verification_uri: v.verification_uri,
        expires_in: v.expires_in,
        interval: v.interval,
      };
    },
  });

  // Fire-and-forget. We expose the verification details via /api/github/device/poll.
  (async () => {
    try {
      const { token } = await auth({ type: 'oauth' });
      session.token = token;
      session.done = true;
    } catch (err) {
      session.error = err.message || String(err);
      session.done = true;
    }
  })();

  sessions.set(id, session);
  // Auto-cleanup after 20 minutes.
  setTimeout(() => sessions.delete(id), 20 * 60 * 1000).unref?.();
  return session;
}

function pollDeviceFlow(id) {
  const s = sessions.get(id);
  if (!s) return { error: 'unknown session' };
  return {
    verification: s.verification,
    token: s.token,
    error: s.error,
    done: s.done,
  };
}

function cancelDeviceFlow(id) {
  sessions.delete(id);
}

// --- REST helpers (token-authed) ---

async function getUser(token) {
  const r = await request('GET /user', { headers: { authorization: `token ${token}` } });
  return r.data;
}

// Create a repo under the authed user (or an org if `owner` differs from the
// authed login). Returns the repo's https clone URL.
async function createRepo(token, { name, owner, isPrivate = true, description }) {
  let route = 'POST /user/repos';
  const body = { name, private: !!isPrivate, description: description || '', auto_init: false };
  if (owner) {
    const me = await getUser(token);
    if (me.login.toLowerCase() !== String(owner).toLowerCase()) {
      route = 'POST /orgs/{org}/repos';
      body.org = owner;
    }
  }
  const r = await request(route, {
    headers: { authorization: `token ${token}` },
    ...body,
  });
  return r.data;
}

async function getRepo(token, owner, name) {
  const r = await request('GET /repos/{owner}/{repo}', {
    headers: { authorization: `token ${token}` },
    owner, repo: name,
  });
  return r.data;
}

// Sanity check a pasted PAT — returns the login or throws.
async function whoami(token) {
  const u = await getUser(token);
  return { login: u.login, name: u.name || u.login, avatar: u.avatar_url };
}

module.exports = {
  deviceFlowAvailable,
  startDeviceFlow,
  pollDeviceFlow,
  cancelDeviceFlow,
  getUser,
  createRepo,
  getRepo,
  whoami,
};
