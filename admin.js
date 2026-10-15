'use strict';
// Admin dashboard for Wholby Proxy.
//
// A separate web server (ADMIN_PORT, bound to 127.0.0.1 by default) so the login page is never part of the public
// customer-facing address. It is protected by a single admin password that is stored only as a salted scrypt hash.
// Set the password with:  npm run admin-password

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE = 'wbp_admin';
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_CLIENT = 5;
const MAX_FAILS_ALL_CLIENTS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// ---------- password and session helpers (exported for tests and the CLI) ----------

const hashPassword = (password) => {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return { salt: salt.toString('hex'), hash: hash.toString('hex'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen };
};

const verifyPassword = (password, record) => {
    if (!record || typeof password !== 'string') return false;
    try {
        const expected = Buffer.from(record.hash, 'hex');
        const actual = crypto.scryptSync(password, Buffer.from(record.salt, 'hex'), expected.length, { N: record.N, r: record.r, p: record.p });
        return crypto.timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
};

// A session cookie is "<expiry>.<nonce>.<signature>". It is stateless; changing the password changes the secret and
// signs everyone out.
const signSession = (secret, now = Date.now()) => {
    const body = `${now + SESSION_MS}.${crypto.randomBytes(12).toString('hex')}`;
    return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
};

const verifySession = (secret, value, now = Date.now()) => {
    if (typeof value !== 'string' || !secret) return false;
    const parts = value.split('.');
    if (parts.length !== 3) return false;
    const [expiry, nonce, signature] = parts;
    const expected = crypto.createHmac('sha256', secret).update(`${expiry}.${nonce}`).digest('hex');
    const a = Buffer.from(signature, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    return Number(expiry) > now;
};

const adminFile = (dataDir) => path.join(dataDir, 'admin.json');

// Writes a new password (and a fresh session secret, which signs out every existing session).
const savePassword = (dataDir, password) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const record = { password: hashPassword(password), sessionSecret: crypto.randomBytes(32).toString('hex') };
    const tmp = `${adminFile(dataDir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, adminFile(dataDir));
};

const readAdminRecord = (dataDir) => {
    try {
        const rec = JSON.parse(fs.readFileSync(adminFile(dataDir), 'utf8'));
        return rec && rec.password && rec.sessionSecret ? rec : null;
    } catch {
        return null;
    }
};

// ---------- checking an Emby address ----------

// Asks <url>/System/Info/Public and decides whether an Emby (or Jellyfin-style) server answered.
const probeEmby = async (url, fetchImpl = fetch) => {
    const started = Date.now();
    try {
        const r = await fetchImpl(`${url}/System/Info/Public`, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
        const body = await r.json().catch(() => null);
        const looksLikeEmby = Boolean(body && typeof body === 'object' && (body.ServerName || body.Version));
        return {
            ok: r.ok && looksLikeEmby,
            status: r.status,
            ms: Date.now() - started,
            serverName: (body && body.ServerName) || null,
            version: (body && body.Version) || null,
            error: r.ok && !looksLikeEmby ? 'That address answered, but it does not look like an Emby server.' : (!r.ok ? `The server answered with an error (${r.status}).` : undefined),
        };
    } catch (err) {
        return { ok: false, status: 0, ms: Date.now() - started, error: err.name === 'TimeoutError' ? 'No answer within 8 seconds.' : 'Could not connect to that address.' };
    }
};

// ---------- the app ----------

const createAdminApp = (ctx) => {
    const app = express();
    app.disable('x-powered-by');

    // Failed-login tracking: per client address and across all clients.
    const failures = new Map();
    const allFailures = [];
    const recentFails = (list, now) => list.filter((t) => now - t < FAIL_WINDOW_MS);
    const clientKey = (req) => {
        const remote = req.socket.remoteAddress || 'unknown';
        const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
        const forwarded = loopback && req.headers['x-forwarded-for'];
        return forwarded ? String(forwarded).split(',')[0].trim() : remote;
    };
    const retryAfterSeconds = (req, now = Date.now()) => {
        const mine = recentFails(failures.get(clientKey(req)) || [], now);
        const all = recentFails(allFailures, now);
        if (mine.length >= MAX_FAILS_PER_CLIENT) return Math.ceil((FAIL_WINDOW_MS - (now - mine[0])) / 1000);
        if (all.length >= MAX_FAILS_ALL_CLIENTS) return Math.ceil((FAIL_WINDOW_MS - (now - all[0])) / 1000);
        return 0;
    };
    const recordFailure = (req, now = Date.now()) => {
        const key = clientKey(req);
        failures.set(key, [...recentFails(failures.get(key) || [], now), now]);
        allFailures.push(now);
        while (allFailures.length && now - allFailures[0] >= FAIL_WINDOW_MS) allFailures.shift();
        if (failures.size > 1000) failures.delete(failures.keys().next().value);
    };

    const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || req.secure;
    const getCookie = (req, name) => {
        for (const part of String(req.headers.cookie || '').split(';')) {
            const eq = part.indexOf('=');
            if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
        }
        return null;
    };
    const setSessionCookie = (req, res, value, maxAgeMs) => {
        res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(value)}; Max-Age=${Math.floor(maxAgeMs / 1000)}; Path=/; HttpOnly; SameSite=Strict${isHttps(req) ? '; Secure' : ''}`);
    };

    // Security headers on every response.
    app.use((req, res, next) => {
        res.set({
            'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'no-referrer',
            'Cache-Control': 'no-store',
            'Cross-Origin-Opener-Policy': 'same-origin',
        });
        next();
    });

    app.use(express.json({ limit: '4kb' }));

    // State-changing requests must be JSON and carry a custom header, which a cross-site form or link cannot send.
    const requireJsonAction = (req, res, next) => {
        if (req.method === 'POST' && (req.headers['x-requested-with'] !== 'wholby-admin' || !req.is('application/json'))) {
            return res.status(400).json({ error: 'Bad request.' });
        }
        next();
    };

    const isAuthenticated = (req) => {
        const rec = readAdminRecord(ctx.dataDir);
        return Boolean(rec) && verifySession(rec.sessionSecret, getCookie(req, COOKIE));
    };
    const requireAuth = (req, res, next) => {
        if (!readAdminRecord(ctx.dataDir)) return res.status(503).json({ error: 'The admin password is not set yet. Run: npm run admin-password' });
        if (!isAuthenticated(req)) return res.status(401).json({ error: 'Please log in.' });
        next();
    };

    app.get('/api/me', (req, res) => {
        res.json({ configured: Boolean(readAdminRecord(ctx.dataDir)), authenticated: isAuthenticated(req) });
    });

    app.post('/api/login', requireJsonAction, async (req, res) => {
        const rec = readAdminRecord(ctx.dataDir);
        if (!rec) return res.status(503).json({ error: 'The admin password is not set yet. Run: npm run admin-password' });
        const wait = retryAfterSeconds(req);
        if (wait > 0) {
            res.set('Retry-After', String(wait));
            return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` });
        }
        const password = req.body && req.body.password;
        if (typeof password !== 'string' || password.length > 200 || !verifyPassword(password, rec.password)) {
            recordFailure(req);
            await new Promise((r) => setTimeout(r, ctx.failDelayMs ?? 400));
            return res.status(401).json({ error: 'Wrong password.' });
        }
        failures.delete(clientKey(req));
        setSessionCookie(req, res, signSession(rec.sessionSecret), SESSION_MS);
        res.json({ ok: true });
    });

    app.post('/api/logout', requireJsonAction, (req, res) => {
        setSessionCookie(req, res, '', 0);
        res.json({ ok: true });
    });

    app.get('/api/status', requireAuth, (req, res) => {
        const nowMinute = Math.floor(Date.now() / 60000);
        const perMinute = [];
        for (let m = nowMinute - 59; m <= nowMinute; m += 1) perMinute.push(ctx.stats.perMinute.get(m) || 0);
        let embyHost = ctx.settings.embyUrl;
        try { embyHost = new URL(ctx.settings.embyUrl).host; } catch { /* keep raw */ }
        res.json({
            version: ctx.version,
            uptimeSeconds: Math.floor((Date.now() - ctx.stats.startedAt) / 1000),
            listen: ctx.listen,
            embyHost,
            serverIdStart: String(ctx.serverId || '').slice(0, 8),
            requests: {
                total: ctx.stats.requests,
                lastHour: perMinute.reduce((a, b) => a + b, 0),
                status: { ...ctx.stats.status },
                embyErrors: ctx.stats.embyErrors,
                perMinute,
            },
            sessions: ctx.counts(),
            errorCount: ctx.recentErrors.length,
            settings: { ...ctx.settings },
        });
    });

    app.get('/api/errors', requireAuth, (req, res) => {
        res.json({ errors: [...ctx.recentErrors].reverse().slice(0, 100) });
    });

    app.post('/api/clear-errors', requireAuth, requireJsonAction, (req, res) => {
        ctx.clearErrors();
        res.json({ ok: true });
    });

    app.post('/api/settings', requireAuth, requireJsonAction, async (req, res) => {
        const checked = ctx.validateSettings(req.body);
        if (!checked.ok) return res.status(400).json({ errors: checked.errors });
        // A new Emby address is only saved if an Emby server really answers there.
        const embyChanged = Boolean(checked.value.embyUrl) && checked.value.embyUrl !== ctx.settings.embyUrl;
        if (embyChanged) {
            const probe = await probeEmby(checked.value.embyUrl, ctx.fetchImpl);
            if (!probe.ok) return res.status(400).json({ errors: [`Nothing was changed. ${probe.error}`] });
        }
        const result = ctx.applySettings(req.body);
        if (!result.ok) return res.status(400).json({ errors: result.errors });
        res.json({ ok: true, settings: { ...ctx.settings }, signedEveryoneOut: embyChanged });
    });

    // Try an address without saving it.
    app.post('/api/test-emby', requireAuth, requireJsonAction, async (req, res) => {
        const parsed = ctx.validateSettings({ embyUrl: req.body && req.body.url });
        if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
        res.json({ url: parsed.value.embyUrl, ...(await probeEmby(parsed.value.embyUrl, ctx.fetchImpl)) });
    });

    app.post('/api/check-emby', requireAuth, requireJsonAction, async (req, res) => {
        res.json(await probeEmby(ctx.settings.embyUrl, ctx.fetchImpl));
    });

    // The dashboard page and its files.
    app.use(express.static(path.join(__dirname, 'admin'), { index: 'index.html', dotfiles: 'deny', maxAge: 0 }));

    // Invalid JSON and other errors never leak details.
    app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
        res.status(err.status && err.status < 500 ? err.status : 500).json({ error: 'Bad request.' });
    });

    return app;
};

const start = (ctx) => {
    const app = createAdminApp(ctx);
    const server = app.listen(ctx.port, ctx.host, () => {
        const note = readAdminRecord(ctx.dataDir) ? '' : ' (no password set yet: run `npm run admin-password`)';
        console.log(`[Admin] dashboard on http://${ctx.host}:${ctx.port}${note}`);
    });
    server.on('error', (err) => console.error('[Admin] could not start the dashboard:', err.message));
    return server;
};

module.exports = { start, createAdminApp, probeEmby, hashPassword, verifyPassword, signSession, verifySession, savePassword, readAdminRecord, SESSION_MS };
