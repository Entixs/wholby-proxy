const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wholby-admin-test-'));
process.env.TOKEN_FILE = path.join(tmp, 'tokens.json'); // settings.json and admin.json live next to it
const test = require('node:test');
const assert = require('node:assert');
const { hashPassword, verifyPassword, signSession, verifySession, savePassword, readAdminRecord, createAdminApp } = require('./admin');
const http = require('node:http');
const server = require('./server');

test('password hashing: right password verifies, wrong one does not, hashes are salted', () => {
    const a = hashPassword('correct horse battery');
    const b = hashPassword('correct horse battery');
    assert.ok(verifyPassword('correct horse battery', a));
    assert.ok(!verifyPassword('correct horse batterz', a));
    assert.ok(!verifyPassword('', a));
    assert.notStrictEqual(a.hash, b.hash);
    assert.ok(!JSON.stringify(a).includes('correct'));
});

test('sessions: valid until expiry, rejected when tampered or signed with another secret', () => {
    const cookie = signSession('secret-1', 1000);
    assert.ok(verifySession('secret-1', cookie, 2000));
    assert.ok(!verifySession('secret-2', cookie, 2000));
    assert.ok(!verifySession('secret-1', cookie, 1000 + 13 * 60 * 60 * 1000));
    const [exp, nonce, sig] = cookie.split('.');
    assert.ok(!verifySession('secret-1', `${Number(exp) + 99999999}.${nonce}.${sig}`, 2000));
    assert.ok(!verifySession('secret-1', 'garbage', 2000));
    assert.ok(!verifySession('secret-1', undefined, 2000));
});

test('settings validation accepts good values and rejects bad ones', () => {
    assert.ok(server.validateSettings({ streamMode: 'proxy', directPlayOnly: false, reportedVersion: '10.11.0', resumeFetchLimit: 200, debug: true }).ok);
    for (const bad of [{ streamMode: 'fast' }, { directPlayOnly: 'yes' }, { reportedVersion: '10.x' }, { reportedVersion: '1.2.3.4' },
        { resumeFetchLimit: 5 }, { resumeFetchLimit: 9999 }, { resumeFetchLimit: '100' }, { debug: 1 }, { nope: true }, null, []]) {
        assert.ok(!server.validateSettings(bad).ok, JSON.stringify(bad));
    }
});

test('applySettings changes the live settings and saves them to settings.json', () => {
    const before = { ...server.settings };
    try {
        const result = server.applySettings({ streamMode: 'redirect', resumeFetchLimit: 150 });
        assert.ok(result.ok);
        assert.strictEqual(server.settings.streamMode, 'redirect');
        const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
        assert.deepStrictEqual(saved, { streamMode: 'redirect', resumeFetchLimit: 150 });
        assert.ok(!server.applySettings({ streamMode: 'bad' }).ok);
        assert.strictEqual(server.settings.streamMode, 'redirect'); // unchanged by the rejected call
    } finally {
        Object.assign(server.settings, before);
    }
});

// ----- the dashboard over real HTTP -----

const startAdmin = async () => {
    const dataDir = fs.mkdtempSync(path.join(tmp, 'admin-'));
    const settings = { embyUrl: 'http://127.0.0.1:1', streamMode: 'auto', directPlayOnly: true, reportedVersion: '10.10.7', resumeFetchLimit: 100, debug: false };
    const errors = [{ at: Date.now(), text: '[Emby Error] 500 GET /Items' }];
    const ctx = {
        dataDir, settings, stats: { startedAt: Date.now() - 5000, requests: 7, status: { s2xx: 5, s3xx: 1, s4xx: 1, s5xx: 0 }, embyErrors: 1, perMinute: new Map([[Math.floor(Date.now() / 60000), 7]]) },
        recentErrors: errors, clearErrors: () => { errors.length = 0; },
        validateSettings: server.validateSettings,
        applySettings: (patch) => { const r = server.validateSettings(patch); if (r.ok) Object.assign(settings, r.value); return r; },
        serverId: '12345678-aaaa-bbbb-cccc-1234567890ab', listen: { host: '127.0.0.1', port: 8096 },
        counts: () => ({ logins: 2, playSessions: 3, devices: 1 }), version: '1.0.0', failDelayMs: 0,
    };
    const http = createAdminApp(ctx).listen(0, '127.0.0.1');
    await new Promise((r) => http.once('listening', r));
    const base = `http://127.0.0.1:${http.address().port}`;
    let cookie = '';
    const call = async (method, p, body, extraHeaders = {}) => {
        const headers = { ...(cookie ? { cookie } : {}), ...extraHeaders };
        if (body !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'x-requested-with': 'wholby-admin' }, extraHeaders);
        const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
        const set = res.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
        let json; try { json = await res.json(); } catch { /* not JSON */ }
        return { status: res.status, json, headers: res.headers, ctx };
    };
    return { ctx, dataDir, http, call, close: () => http.close() };
};

test('dashboard: nothing works before a password exists', async () => {
    const a = await startAdmin();
    try {
        assert.deepStrictEqual((await a.call('GET', '/api/me')).json, { configured: false, authenticated: false });
        assert.strictEqual((await a.call('POST', '/api/login', { password: 'whatever12345' })).status, 503);
        assert.strictEqual((await a.call('GET', '/api/status')).status, 503);
    } finally { a.close(); }
});

test('dashboard: login, status, settings, errors and logout', async () => {
    const a = await startAdmin();
    try {
        savePassword(a.dataDir, 'a-very-long-password');
        assert.strictEqual(fs.statSync(path.join(a.dataDir, 'admin.json')).mode & 0o777, 0o600);
        assert.ok(!fs.readFileSync(path.join(a.dataDir, 'admin.json'), 'utf8').includes('a-very-long-password'));

        assert.strictEqual((await a.call('GET', '/api/status')).status, 401);
        assert.strictEqual((await a.call('POST', '/api/login', { password: 'wrong-password-123' })).status, 401);
        const login = await a.call('POST', '/api/login', { password: 'a-very-long-password' });
        assert.strictEqual(login.status, 200);
        assert.match(login.headers.get('set-cookie'), /HttpOnly/);
        assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);

        assert.strictEqual((await a.call('GET', '/api/me')).json.authenticated, true);
        const status = (await a.call('GET', '/api/status')).json;
        assert.strictEqual(status.requests.total, 7);
        assert.strictEqual(status.embyHost, '127.0.0.1:1');
        assert.strictEqual(status.serverIdStart, '12345678');
        assert.strictEqual(status.requests.perMinute.length, 60);
        assert.strictEqual(status.settings.streamMode, 'auto');
        assert.ok(!JSON.stringify(status).includes('1234567890ab'));

        const saved = await a.call('POST', '/api/settings', { streamMode: 'proxy', resumeFetchLimit: 250 });
        assert.strictEqual(saved.status, 200);
        assert.strictEqual(a.ctx.settings.streamMode, 'proxy');
        const rejected = await a.call('POST', '/api/settings', { streamMode: 'warp' });
        assert.strictEqual(rejected.status, 400);
        assert.strictEqual(a.ctx.settings.streamMode, 'proxy');

        assert.strictEqual((await a.call('GET', '/api/errors')).json.errors.length, 1);
        await a.call('POST', '/api/clear-errors', {});
        assert.strictEqual((await a.call('GET', '/api/errors')).json.errors.length, 0);

        const check = (await a.call('POST', '/api/check-emby', {})).json;
        assert.strictEqual(check.ok, false); // nothing listens on port 1

        await a.call('POST', '/api/logout', {});
        assert.strictEqual((await a.call('GET', '/api/status')).status, 401);
    } finally { a.close(); }
});

test('dashboard: changing the password signs existing sessions out', async () => {
    const a = await startAdmin();
    try {
        savePassword(a.dataDir, 'first-long-password');
        await a.call('POST', '/api/login', { password: 'first-long-password' });
        assert.strictEqual((await a.call('GET', '/api/status')).status, 200);
        savePassword(a.dataDir, 'second-long-password');
        assert.strictEqual((await a.call('GET', '/api/status')).status, 401);
        assert.strictEqual((await a.call('POST', '/api/login', { password: 'first-long-password' })).status, 401);
        assert.strictEqual((await a.call('POST', '/api/login', { password: 'second-long-password' })).status, 200);
    } finally { a.close(); }
});

test('dashboard: posts need the JSON content type and the custom header (cross-site protection)', async () => {
    const a = await startAdmin();
    try {
        savePassword(a.dataDir, 'a-very-long-password');
        await a.call('POST', '/api/login', { password: 'a-very-long-password' });
        const withoutHeader = await fetch(`http://127.0.0.1:${a.http.address().port}/api/settings`, {
            method: 'POST', headers: { cookie: 'x', 'content-type': 'application/json' }, body: JSON.stringify({ debug: true }),
        });
        assert.ok([400, 401].includes(withoutHeader.status));
        const asForm = await fetch(`http://127.0.0.1:${a.http.address().port}/api/logout`, {
            method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-requested-with': 'wholby-admin' }, body: 'a=b',
        });
        assert.strictEqual(asForm.status, 400);
        assert.strictEqual(a.ctx.settings.debug, false);
    } finally { a.close(); }
});

test('dashboard: repeated wrong passwords are blocked, even the right one afterwards', async () => {
    const a = await startAdmin();
    try {
        savePassword(a.dataDir, 'a-very-long-password');
        for (let i = 0; i < 5; i += 1) assert.strictEqual((await a.call('POST', '/api/login', { password: `wrong-guess-${i}-xx` })).status, 401);
        const blocked = await a.call('POST', '/api/login', { password: 'a-very-long-password' });
        assert.strictEqual(blocked.status, 429);
        assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    } finally { a.close(); }
});

test('dashboard: pages carry strict security headers and invalid JSON does not leak details', async () => {
    const a = await startAdmin();
    try {
        const page = await fetch(`http://127.0.0.1:${a.http.address().port}/`);
        assert.strictEqual(page.status, 200);
        assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
        assert.strictEqual(page.headers.get('x-frame-options'), 'DENY');
        assert.strictEqual(page.headers.get('cache-control'), 'no-store');
        const html = await page.text();
        assert.ok(!/<script>/i.test(html) && !/ style=/i.test(html), 'no inline script or style');
        const bad = await fetch(`http://127.0.0.1:${a.http.address().port}/api/login`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'wholby-admin' }, body: '{not json',
        });
        assert.strictEqual(bad.status, 400);
        assert.deepStrictEqual(await bad.json(), { error: 'Bad request.' });
        assert.strictEqual((await fetch(`http://127.0.0.1:${a.http.address().port}/..%2fserver.js`)).status === 200, false);
    } finally { a.close(); }
});

// ----- changing the Emby server -----

test('Emby addresses: plain http(s) only, tidied up, no credentials or placeholders', () => {
    assert.deepStrictEqual(server.parseEmbyUrl('http://192.168.1.100:8096/'), { ok: true, url: 'http://192.168.1.100:8096' });
    assert.deepStrictEqual(server.parseEmbyUrl('  https://emby.example.com  '), { ok: true, url: 'https://emby.example.com' });
    assert.deepStrictEqual(server.parseEmbyUrl('https://example.com/emby-base///'), { ok: true, url: 'https://example.com/emby-base' });
    for (const bad of ['', '   ', 'emby.example.com', 'ftp://example.com', 'javascript:alert(1)', 'http://user:pass@example.com', 'http://example.com/?x=1', 'http://example.com/#a', 'http://YOUR_EMBY_IP:8096', 'http://', 42, null, undefined, `http://${'a'.repeat(400)}.com`]) {
        assert.strictEqual(server.parseEmbyUrl(bad).ok, false, String(bad));
    }
    assert.ok(server.validateSettings({ embyUrl: 'http://10.0.0.5:8096/' }).ok);
    assert.strictEqual(server.validateSettings({ embyUrl: 'http://10.0.0.5:8096/' }).value.embyUrl, 'http://10.0.0.5:8096');
});

const fakeServer = (handler) => new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => s.close() }));
});
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

test('dashboard: testing and saving a new Emby address', async () => {
    const emby = await fakeServer((req, res) => (req.url === '/System/Info/Public' ? json(res, 200, { ServerName: 'Fake Emby', Version: '4.9.5.0' }) : json(res, 404, {})));
    const notEmby = await fakeServer((req, res) => json(res, 200, { hello: 'world' }));
    const broken = await fakeServer((req, res) => json(res, 500, { error: 'boom' }));
    const a = await startAdmin();
    try {
        savePassword(a.dataDir, 'a-very-long-password');
        await a.call('POST', '/api/login', { password: 'a-very-long-password' });

        const good = (await a.call('POST', '/api/test-emby', { url: `${emby.url}/` })).json;
        assert.strictEqual(good.ok, true);
        assert.strictEqual(good.url, emby.url);
        assert.strictEqual(good.serverName, 'Fake Emby');
        assert.strictEqual((await a.call('POST', '/api/test-emby', { url: notEmby.url })).json.ok, false);
        assert.match((await a.call('POST', '/api/test-emby', { url: notEmby.url })).json.error, /does not look like an Emby server/);
        assert.strictEqual((await a.call('POST', '/api/test-emby', { url: broken.url })).json.ok, false);
        assert.strictEqual((await a.call('POST', '/api/test-emby', { url: 'http://127.0.0.1:1' })).json.ok, false);
        assert.strictEqual((await a.call('POST', '/api/test-emby', { url: 'not a url' })).status, 400);
        assert.strictEqual((await a.call('POST', '/api/test-emby', { url: 'http://me:secret@example.com' })).status, 400);
        assert.strictEqual(a.ctx.settings.embyUrl, 'http://127.0.0.1:1', 'testing never saves');

        // Saving refuses an address where no Emby server answers, and changes nothing.
        for (const bad of [notEmby.url, broken.url, 'http://127.0.0.1:2']) {
            const r = await a.call('POST', '/api/settings', { embyUrl: bad, streamMode: 'proxy' });
            assert.strictEqual(r.status, 400, bad);
            assert.match(r.json.errors[0], /Nothing was changed/);
        }
        assert.strictEqual(a.ctx.settings.embyUrl, 'http://127.0.0.1:1');
        assert.strictEqual(a.ctx.settings.streamMode, 'auto', 'other fields are not half-saved either');

        // A working address is saved, and the page is told everyone was signed out.
        const saved = await a.call('POST', '/api/settings', { embyUrl: `${emby.url}/` });
        assert.strictEqual(saved.status, 200);
        assert.strictEqual(saved.json.signedEveryoneOut, true);
        assert.strictEqual(a.ctx.settings.embyUrl, emby.url);
        assert.strictEqual((await a.call('GET', '/api/status')).json.embyHost, new URL(emby.url).host);
        assert.strictEqual((await a.call('POST', '/api/check-emby', {})).json.serverName, 'Fake Emby');

        // The same address again is not a change.
        const again = await a.call('POST', '/api/settings', { embyUrl: emby.url, debug: true });
        assert.strictEqual(again.status, 200);
        assert.strictEqual(again.json.signedEveryoneOut, false);
    } finally { a.close(); emby.close(); notEmby.close(); broken.close(); }
});

test('changing the Emby server signs everyone out, but loading saved settings at startup does not', () => {
    const before = { ...server.settings };
    try {
        server.rememberPlaySession('sess-x', 'TOKEN-X');
        server.rememberDevice({ authorization: 'MediaBrowser Client="W", Device="TV", DeviceId="dev-x", Version="1", Token="TOKEN-X"' });
        assert.strictEqual(server.resolveStreamToken('/Audio/1/stream?playSessionId=sess-x', {}), 'TOKEN-X');

        // startup: persist:false must keep logins
        assert.ok(server.applySettings({ embyUrl: 'http://10.9.9.9:8096' }, { persist: false }).ok);
        assert.strictEqual(server.resolveStreamToken('/Audio/1/stream?playSessionId=sess-x', {}), 'TOKEN-X');

        // dashboard save of a different address clears them
        assert.ok(server.applySettings({ embyUrl: 'http://10.8.8.8:8096' }).ok);
        assert.strictEqual(server.settings.embyUrl, 'http://10.8.8.8:8096');
        assert.strictEqual(server.resolveStreamToken('/Audio/1/stream?playSessionId=sess-x', {}), null);
        assert.strictEqual(server.resolveStreamToken('/Audio/1/stream?deviceId=dev-x', {}), null);

        // the same address again does not clear anything new
        server.rememberPlaySession('sess-y', 'TOKEN-Y');
        assert.ok(server.applySettings({ embyUrl: 'http://10.8.8.8:8096' }).ok);
        assert.strictEqual(server.resolveStreamToken('/Audio/1/stream?playSessionId=sess-y', {}), 'TOKEN-Y');
    } finally {
        Object.assign(server.settings, before);
    }
});
