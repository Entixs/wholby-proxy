'use strict';

const $ = (id) => document.getElementById(id);
const show = (id) => {
    for (const v of ['loading', 'notConfigured', 'loginView', 'dashView']) $(v).hidden = v !== id;
};

// All requests go through here. POSTs carry a custom header and JSON, which the server requires.
const api = async (path, body) => {
    const options = body === undefined
        ? { credentials: 'same-origin' }
        : {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'wholby-admin' },
            body: JSON.stringify(body),
        };
    const res = await fetch(path, options);
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, ok: res.ok, data };
};

const number = (n) => Number(n || 0).toLocaleString();
const duration = (seconds) => {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m`;
    return `${seconds}s`;
};

let refreshTimer = null;
let settingsDirty = false;
let currentEmbyUrl = '';

const drawChart = (values) => {
    const svg = $('chart');
    svg.replaceChildren();
    const max = Math.max(1, ...values);
    const width = 240 / values.length;
    values.forEach((v, i) => {
        const h = Math.max(v ? 2 : 0.5, (v / max) * 46);
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(i * width + 0.4));
        rect.setAttribute('y', String(48 - h));
        rect.setAttribute('width', String(Math.max(width - 0.8, 0.5)));
        rect.setAttribute('height', String(h));
        rect.setAttribute('rx', '1');
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = `${v} request${v === 1 ? '' : 's'}, ${values.length - 1 - i} minute${values.length - 1 - i === 1 ? '' : 's'} ago`;
        rect.appendChild(title);
        svg.appendChild(rect);
    });
};

const fillSettings = (s) => {
    $('embyUrl').value = s.embyUrl;
    currentEmbyUrl = s.embyUrl;
    $('streamMode').value = s.streamMode;
    $('directPlayOnly').checked = s.directPlayOnly;
    $('reportedVersion').value = s.reportedVersion;
    $('resumeFetchLimit').value = s.resumeFetchLimit;
    $('debug').checked = s.debug;
};

const renderStatus = (s) => {
    $('subtitle').textContent = `Version ${s.version}`;
    $('uptime').textContent = duration(s.uptimeSeconds);
    $('lastHour').textContent = number(s.requests.lastHour);
    $('total').textContent = number(s.requests.total);
    $('embyErrors').textContent = number(s.requests.embyErrors);
    const st = s.requests.status;
    $('statusSplit').textContent = `Answers: ${number(st.s2xx)} OK, ${number(st.s3xx)} redirects, ${number(st.s4xx)} client errors, ${number(st.s5xx)} server errors.`;
    drawChart(s.requests.perMinute);
    $('embyHost').textContent = s.embyHost;
    $('logins').textContent = number(s.sessions.logins);
    $('playSessions').textContent = number(s.sessions.playSessions);
    $('devices').textContent = number(s.sessions.devices);
    $('listen').textContent = `${s.listen.host}:${s.listen.port}`;
    $('serverId').textContent = s.serverIdStart ? `${s.serverIdStart}...` : '-';
    if (!settingsDirty) fillSettings(s.settings);
};

const renderErrors = (errors) => {
    const list = $('errors');
    list.replaceChildren();
    $('noErrors').hidden = errors.length > 0;
    $('clearErrors').hidden = errors.length === 0;
    for (const e of errors) {
        const li = document.createElement('li');
        const time = document.createElement('time');
        time.dateTime = new Date(e.at).toISOString();
        time.textContent = new Date(e.at).toLocaleTimeString();
        const text = document.createElement('span');
        text.textContent = e.text;
        li.append(time, text);
        list.appendChild(li);
    }
};

const refresh = async () => {
    const [status, errors] = await Promise.all([api('/api/status'), api('/api/errors')]);
    if (status.status === 401) return start();
    if (status.ok) renderStatus(status.data);
    if (errors.ok) renderErrors(errors.data.errors);
};

const setEmbyPill = (ok, text) => {
    const pill = $('embyPill');
    pill.textContent = text;
    pill.className = `pill ${ok ? 'ok' : 'bad'}`;
};

const checkEmby = async () => {
    const button = $('checkEmby');
    button.disabled = true;
    $('embyResult').textContent = 'Checking...';
    const { data } = await api('/api/check-emby', {});
    button.disabled = false;
    if (data.ok) {
        const label = [data.serverName, data.version && `v${data.version}`].filter(Boolean).join(' ');
        $('embyResult').textContent = `OK in ${data.ms} ms${label ? ` (${label})` : ''}`;
        setEmbyPill(true, 'Emby: connected');
    } else {
        $('embyResult').textContent = data.error || `Emby answered ${data.status}`;
        setEmbyPill(false, 'Emby: problem');
    }
};

const showDashboard = () => {
    show('dashView');
    refresh();
    checkEmby();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(refresh, 10000);
};

async function start() {
    clearInterval(refreshTimer);
    show('loading');
    const { data } = await api('/api/me');
    if (!data.configured) return show('notConfigured');
    if (!data.authenticated) { show('loginView'); $('password').focus(); return undefined; }
    return showDashboard();
}

$('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('loginError');
    error.hidden = true;
    const button = event.submitter || $('loginForm').querySelector('button');
    button.disabled = true;
    const { ok, data } = await api('/api/login', { password: $('password').value });
    button.disabled = false;
    $('password').value = '';
    if (!ok) {
        error.textContent = data.error || 'Could not log in.';
        error.hidden = false;
        return;
    }
    start();
});

$('logout').addEventListener('click', async () => {
    await api('/api/logout', {});
    start();
});

$('checkEmby').addEventListener('click', checkEmby);

$('clearErrors').addEventListener('click', async () => {
    await api('/api/clear-errors', {});
    refresh();
});

for (const id of ['embyUrl', 'streamMode', 'directPlayOnly', 'reportedVersion', 'resumeFetchLimit', 'debug']) {
    $(id).addEventListener('input', () => { settingsDirty = true; });
}

$('testEmby').addEventListener('click', async () => {
    const message = $('embyTestMsg');
    const button = $('testEmby');
    button.disabled = true;
    message.hidden = false;
    message.className = 'note';
    message.textContent = 'Testing...';
    const { ok, data } = await api('/api/test-emby', { url: $('embyUrl').value.trim() });
    button.disabled = false;
    if (!ok) {
        message.className = 'note bad';
        message.textContent = (data.errors || [data.error || 'Could not test that address.']).join(' ');
    } else if (data.ok) {
        const label = [data.serverName, data.version && `v${data.version}`].filter(Boolean).join(' ');
        message.textContent = `Emby answered in ${data.ms} ms${label ? ` (${label})` : ''}.`;
    } else {
        message.className = 'note bad';
        message.textContent = data.error || 'Nothing answered there.';
    }
});

$('settingsForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = $('settingsMsg');
    const embyUrl = $('embyUrl').value.trim();
    if (embyUrl.replace(/\/+$/, '') !== currentEmbyUrl && !window.confirm('Change the Emby server?\n\nEveryone will be signed out of Wholphin and must log in again with their account on the new server.')) return;
    const { ok, data } = await api('/api/settings', {
        embyUrl,
        streamMode: $('streamMode').value,
        directPlayOnly: $('directPlayOnly').checked,
        reportedVersion: $('reportedVersion').value.trim(),
        resumeFetchLimit: Number.parseInt($('resumeFetchLimit').value, 10),
        debug: $('debug').checked,
    });
    message.hidden = false;
    message.className = ok ? 'note' : 'note bad';
    if (ok) {
        settingsDirty = false;
        fillSettings(data.settings);
        if (data.signedEveryoneOut) { refresh(); checkEmby(); } // the cards above should show the new server straight away
        message.textContent = data.signedEveryoneOut ? 'Saved. The new Emby server is in use and everyone has been signed out of Wholphin.' : 'Saved. The new settings are already in use.';
    } else {
        message.textContent = (data.errors || [data.error || 'Could not save.']).join(' ');
    }
});

start();
