const os = require('node:os');
const path = require('node:path');
const tmp = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'wholby-test-'));
process.env.TOKEN_FILE = path.join(tmp, 'tokens.json');
process.env.DISPLAY_PREFS_FILE = path.join(tmp, 'displayprefs.json');
const test = require('node:test');
const assert = require('node:assert');
const { normalizeUserData, asksOnlyForJellyTypes, app, rememberPlaySession, resolveStreamToken, shouldRedirect, planSplit, splitItems, toUUID, deflateUUID, transformPath, isBinaryPath, redact } = require('./server');

const UID = '1a2b3c';

test('toUUID / deflateUUID round-trip for Emby numeric and hex ids', () => {
    for (const id of ['1', '0', '12345', '99999999', 'abcdef0123456789abcdef0123456789']) {
        assert.strictEqual(deflateUUID(toUUID(id)), id);
    }
});

test('non-numeric Emby ids (media sources) pass through unchanged', () => {
    assert.strictEqual(toUUID('mediasource_364241'), 'mediasource_364241');
    assert.strictEqual(transformPath('/Videos/7/stream?MediaSourceId=mediasource_364241', null), '/Videos/7/stream?MediaSourceId=mediasource_364241');
});

test('Jellyfin 10.9+ routes map onto Emby routes', () => {
    const id = toUUID('4242');
    assert.strictEqual(transformPath('/Users/Me', UID), `/emby/Users/${UID}`);
    assert.strictEqual(transformPath('/UserViews', UID), `/emby/Users/${UID}/Views`);
    assert.strictEqual(transformPath(`/UserPlayedItems/${id}`, UID), `/emby/Users/${UID}/PlayedItems/4242`);
    assert.strictEqual(transformPath(`/UserFavoriteItems/${id}`, UID), `/emby/Users/${UID}/FavoriteItems/4242`);
    assert.strictEqual(transformPath(`/UserItems/${id}/UserData`, UID), `/emby/Users/${UID}/Items/4242/UserData`);
});

test('Resume asks Emby for a large batch with a default MediaTypes', () => {
    const out = transformPath('/UserItems/Resume?userId=abc&limit=5&startIndex=2', UID);
    const [path, query] = out.split('?');
    assert.strictEqual(path, `/emby/Users/${UID}/Items/Resume`);
    assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(query)), { MediaTypes: 'Video', Limit: '100' });
    assert.ok(transformPath('/UserItems/Resume?mediaTypes=Audio', UID).includes('mediaTypes=Audio'));
});

test('NextUp is built from the merged Resume list, episodes only', () => {
    const out = transformPath('/Shows/NextUp?userId=abc&limit=8&seriesId=ffffffff-0000-0000-0000-000000000009&fields=Overview', UID);
    const [path, query] = out.split('?');
    assert.strictEqual(path, `/emby/Users/${UID}/Items/Resume`);
    assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(query)), { fields: 'Overview', MediaTypes: 'Video', IncludeItemTypes: 'Episode', Limit: '100' });
});

test('planSplit reads the client request', () => {
    assert.deepStrictEqual(planSplit('/Shows/NextUp?limit=8&startIndex=1&seriesId=ffffffff-0000-0000-0000-000000000009'),
        { kind: 'nextup', limit: 8, startIndex: 1, seriesId: '9' });
    assert.deepStrictEqual(planSplit('/UserItems/Resume'), { kind: 'resume', limit: null, startIndex: 0, seriesId: null });
    assert.strictEqual(planSplit('/Items'), null);
});

const ep = (id, series, pos, extra = {}) => ({ Id: id, Type: 'Episode', SeriesId: series, UserData: { PlaybackPositionTicks: pos }, ...extra });
const sample = { Items: [ep('1', 'A', 500), ep('2', 'B', 0), ep('3', 'B', 0), ep('4', 'C', 0, { UserData: { PlaybackPositionTicks: 0, Played: true } }),
    ep('5', 'D', 0), { Id: '6', Type: 'Movie', UserData: { PlaybackPositionTicks: 900 } }, { Id: '7', Type: 'Movie', UserData: { PlaybackPositionTicks: 0 } }], TotalRecordCount: 7, StartIndex: 0 };

test('Resume keeps only started items and trims to the limit', () => {
    const r = splitItems(sample, { kind: 'resume', limit: 1, startIndex: 0, seriesId: null });
    assert.deepStrictEqual(r.Items.map((i) => i.Id), ['1']);
    assert.strictEqual(r.TotalRecordCount, 2);
    assert.deepStrictEqual(splitItems(sample, { kind: 'resume', limit: null, startIndex: 1, seriesId: null }).Items.map((i) => i.Id), ['6']);
});

test('NextUp keeps unstarted unplayed episodes, one per series', () => {
    const r = splitItems(sample, { kind: 'nextup', limit: 10, startIndex: 0, seriesId: null });
    assert.deepStrictEqual(r.Items.map((i) => i.Id), ['2', '5']);
    assert.strictEqual(r.TotalRecordCount, 2);
    assert.deepStrictEqual(splitItems(sample, { kind: 'nextup', limit: 10, startIndex: 0, seriesId: 'D' }).Items.map((i) => i.Id), ['5']);
});

test('single item and per-user sub-routes go under /Users, global sub-routes do not', () => {
    const id = toUUID('4242');
    assert.strictEqual(transformPath(`/Items/${id}`, UID), `/emby/Users/${UID}/Items/4242`);
    assert.strictEqual(transformPath(`/Items/${id}/Intros`, UID), `/emby/Users/${UID}/Items/4242/Intros`);
    assert.strictEqual(transformPath(`/Items/${id}/Similar?limit=5`, UID), `/emby/Items/4242/Similar?limit=5`);
    assert.strictEqual(transformPath(`/Items/${id}/PlaybackInfo`, UID), `/emby/Items/4242/PlaybackInfo?UserId=${UID}`);
});

test('query cleanup removes Jellyfin-only values and joins repeated keys', () => {
    const out = transformPath('/Items?fields=BasicSyncInfo&fields=Overview&sortBy=Default&includeItemTypes=Movie,LiveTvChannel&userId=' + toUUID(UID), UID);
    const [path, query] = out.split('?');
    assert.strictEqual(path, `/emby/Users/${UID}/Items`);
    assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(query)), { fields: 'Overview', includeItemTypes: 'Movie' });
});

test('deflation leaves DeviceId and PlaySessionId UUIDs alone', () => {
    const dev = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const out = transformPath(`/Videos/${toUUID('7')}/master.m3u8?DeviceId=${dev}&PlaySessionId=${dev}&MediaSourceId=${toUUID('7')}`, UID);
    assert.ok(out.includes(`DeviceId=${dev}`));
    assert.ok(out.includes(`PlaySessionId=${dev}`));
    assert.ok(out.includes('MediaSourceId=7'));
    assert.ok(out.startsWith('/Videos/7/'));
});

test('legacy UserImage becomes an Emby image path', () => {
    assert.strictEqual(transformPath(`/UserImage?userId=${toUUID('55')}&tag=abc`, null), '/emby/Users/55/Images/Primary?tag=abc');
});

test('binary routing', () => {
    assert.ok(isBinaryPath('/Videos/1/stream?static=true'));
    assert.ok(isBinaryPath('/Videos/1/master.m3u8'));
    assert.ok(isBinaryPath('/Items/1/Images/Primary'));
    assert.ok(isBinaryPath('/Videos/1/abc/Subtitles/2/0/Stream.vtt'));
    assert.ok(!isBinaryPath('/Items/1'));
    assert.ok(!isBinaryPath('/Users/AuthenticateByName'));
});

test('redact hides credentials in logs', () => {
    assert.strictEqual(redact('/x?api_key=SECRET&a=1&token=T2'), '/x?api_key=***&a=1&token=***');
});

test('stream mode: auto redirects only when protocols match', () => {
    assert.strictEqual(shouldRedirect('auto', 'https', 'https://emby.example'), true);
    assert.strictEqual(shouldRedirect('auto', 'http', 'https://emby.example'), false);
    assert.strictEqual(shouldRedirect('auto', 'http', 'http://10.0.0.5:8096'), true);
    assert.strictEqual(shouldRedirect('proxy', 'https', 'https://emby.example'), false);
    assert.strictEqual(shouldRedirect('redirect', 'http', 'https://emby.example'), true);
});

test('Jellyfin-only streamOptions parameter is removed (Emby returns 500 for it)', () => {
    const out = transformPath('/Videos/7/stream?static=true&streamOptions=%7B%7D&playSessionId=abc', null);
    assert.ok(!/streamoptions/i.test(out));
    assert.ok(out.includes('static=true') && out.includes('playSessionId=abc'));
});

test('token-less stream requests get the token that owns their PlaySessionId', () => {
    rememberPlaySession('sess1', 'TOKEN-A');
    assert.strictEqual(resolveStreamToken('/Videos/7/stream?static=true&playSessionId=sess1', {}), 'TOKEN-A');
    // already authenticated requests are left alone
    assert.strictEqual(resolveStreamToken('/Videos/7/stream?playSessionId=sess1&api_key=X', {}), null);
    assert.strictEqual(resolveStreamToken('/Videos/7/stream?playSessionId=sess1', { 'x-emby-token': 'Y' }), null);
    // unknown sessions get nothing
    assert.strictEqual(resolveStreamToken('/Videos/7/stream?playSessionId=nope', {}), null);
    assert.strictEqual(resolveStreamToken('/Videos/7/stream', {}), null);
});

test('DisplayPreferences returns every field the Jellyfin DTO requires and persists CustomPrefs', async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const q = '?userId=ffffffff-0000-0000-0000-0000000000aa&client=Wholphin';
        const first = await (await fetch(`${base}/DisplayPreferences/default${q}`)).json();
        for (const f of ['Id', 'RememberIndexing', 'PrimaryImageHeight', 'PrimaryImageWidth', 'CustomPrefs', 'ScrollDirection',
            'ShowBackdrop', 'RememberSorting', 'SortOrder', 'ShowSidebar', 'Client']) {
            assert.ok(f in first, `missing ${f}`);
        }
        assert.deepStrictEqual(first.CustomPrefs, {});
        const post = await fetch(`${base}/DisplayPreferences/default${q}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...first, CustomPrefs: { removeNextUp: 'x' } }),
        });
        assert.strictEqual(post.status, 204);
        const again = await (await fetch(`${base}/DisplayPreferences/default${q}`)).json();
        assert.deepStrictEqual(again.CustomPrefs, { removeNextUp: 'x' });
        // another user does not see it
        const other = await (await fetch(`${base}/DisplayPreferences/default?userId=ffffffff-0000-0000-0000-0000000000bb&client=Wholphin`)).json();
        assert.deepStrictEqual(other.CustomPrefs, {});
    } finally {
        server.close();
    }
});

test('Emby-rejected sort keys are mapped or dropped and sortOrder is joined', () => {
    const out = transformPath('/Items?sortBy=PremiereDate&sortBy=SeriesSortName&sortBy=AiredEpisodeOrder&sortOrder=Descending&sortOrder=Ascending&sortOrder=Descending', UID);
    const q = new URLSearchParams(out.split('?')[1]);
    assert.strictEqual(q.get('sortBy'), 'PremiereDate,SeriesSortName,ParentIndexNumber,IndexNumber');
    assert.strictEqual(q.get('sortOrder'), 'Descending,Ascending,Descending');
    assert.ok(!transformPath('/Items?sortBy=Default', UID).toLowerCase().includes('sortby'));
    assert.ok(!transformPath('/Items?sortBy=VideoBitRate,SortName', UID).includes('VideoBitRate'));
    assert.ok(transformPath('/Items?sortBy=VideoBitRate,SortName', UID).includes('sortBy=SortName'));
});

test('DatePlayed is converted to the compact format Emby accepts', () => {
    assert.ok(transformPath('/UserPlayedItems/5?datePlayed=2026-10-14T23:30:00.000Z', UID).includes('datePlayed=20261014233000'));
    assert.ok(transformPath('/UserPlayedItems/5?datePlayed=garbage', UID).includes('datePlayed=garbage'));
});

test('image fillWidth/fillHeight become maxWidth/maxHeight so Emby resizes', () => {
    const out = transformPath('/Items/5/Images/Primary?fillHeight=344&fillWidth=229&quality=96', UID);
    const q = new URLSearchParams(out.split('?')[1]);
    assert.strictEqual(q.get('maxHeight'), '344');
    assert.strictEqual(q.get('maxWidth'), '229');
    assert.strictEqual(q.get('quality'), '96');
    assert.ok(!q.has('fillHeight') && !q.has('fillWidth'));
    assert.strictEqual(new URLSearchParams(transformPath('/Items/5/Images/Primary?fillHeight=344&maxHeight=100', UID).split('?')[1]).get('maxHeight'), '100');
});

test('/Years is made recursive (Emby returns 500 otherwise)', () => {
    assert.ok(transformPath('/Years?userId=x&sortBy=SortName', UID).includes('Recursive=true'));
    assert.strictEqual(transformPath('/Years', UID), '/Years?Recursive=true');
    assert.ok(transformPath('/Years?recursive=false', UID).includes('recursive=false'));
});

test('queries for only Jellyfin-only item types short-circuit to empty', () => {
    assert.ok(asksOnlyForJellyTypes('/Items?searchTerm=x&includeItemTypes=LiveTvProgram'));
    assert.ok(asksOnlyForJellyTypes('/Items?includeItemTypes=LiveTvChannel,LiveTvProgram'));
    assert.ok(asksOnlyForJellyTypes('/Users/abc/Items?includeItemTypes=LiveTvProgram'));
    assert.ok(!asksOnlyForJellyTypes('/Items?includeItemTypes=Movie,LiveTvProgram'));
    assert.ok(!asksOnlyForJellyTypes('/Items?searchTerm=x'));
    assert.ok(!asksOnlyForJellyTypes('/Items/123/Similar?includeItemTypes=LiveTvProgram'));
});

test('favorite/played responses get the Key and ItemId Jellyfin clients require', () => {
    const out = normalizeUserData({ PlaybackPositionTicks: 0, PlayCount: 1, IsFavorite: true, Played: true }, '1640973');
    assert.strictEqual(out.Key, '1640973');
    assert.strictEqual(out.ItemId, 'ffffffff-0000-0000-0000-000001640973');
    assert.strictEqual(out.IsFavorite, true);
    assert.deepStrictEqual(normalizeUserData({ foo: 1 }, '5'), { foo: 1 });
});
