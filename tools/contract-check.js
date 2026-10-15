#!/usr/bin/env node
// Contract check: calls the running proxy like a Jellyfin client and validates every JSON response against
// Jellyfin's published OpenAPI schema (enums, types, UUID/date formats, required fields).
// Wholphin's JSON parser is strict about these, so a violation here is a crash or blank screen on the client.
//
//   PROXY_URL=http://localhost:8096 EMBY_USER=name EMBY_PASS=pw node tools/contract-check.js
//   (OPENAPI_FILE=path/to/spec.json to avoid downloading the spec)

const fs = require('fs');

const PROXY = (process.env.PROXY_URL || 'http://localhost:8096').replace(/\/+$/, '');
const USER = process.env.EMBY_USER || 'Wholphin';
const PASS = process.env.EMBY_PASS || '';
const SPEC_URL = process.env.OPENAPI_URL || 'https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

let spec;
const findings = new Map(); // key -> { count, example }

const note = (endpoint, schemaName, path, message) => {
    const generic = path.replace(/\[\d+\]/g, '[]');
    const key = `${endpoint} | ${schemaName} | ${generic} | ${message}`;
    const entry = findings.get(key) || { count: 0 };
    entry.count += 1;
    findings.set(key, entry);
};

const resolve = (schema) => {
    let s = schema;
    let nullable = Boolean(s && s.nullable);
    while (s && (s.$ref || (s.allOf && s.allOf.length === 1))) {
        s = s.$ref ? spec.components.schemas[s.$ref.split('/').pop()] : s.allOf[0];
        if (s && s.nullable) nullable = true;
    }
    return { schema: s, nullable, name: schema && schema.$ref ? schema.$ref.split('/').pop() : undefined };
};

const validate = (value, schemaNode, path, ctx) => {
    if (!schemaNode) return;
    const { schema, nullable, name } = resolve(schemaNode);
    if (!schema) return;
    const schemaName = name || ctx.schemaName;

    if (value === null) {
        if (!nullable) note(ctx.endpoint, schemaName, path, 'null where not nullable');
        return;
    }
    if (schema.oneOf || schema.anyOf) return; // not used for response models of interest

    if (schema.enum) {
        if (!schema.enum.includes(value)) note(ctx.endpoint, name || schemaName, path, `enum value ${JSON.stringify(value)} not allowed`);
        return;
    }

    switch (schema.type) {
        case 'string':
            if (typeof value !== 'string') return note(ctx.endpoint, schemaName, path, `expected string, got ${typeof value}`);
            if (schema.format === 'uuid' && !UUID.test(value)) note(ctx.endpoint, schemaName, path, `invalid uuid ${JSON.stringify(value).slice(0, 40)}`);
            if (schema.format === 'date-time' && !DATETIME.test(value)) note(ctx.endpoint, schemaName, path, `invalid date-time ${JSON.stringify(value).slice(0, 40)}`);
            break;
        case 'integer':
            if (!Number.isInteger(value)) note(ctx.endpoint, schemaName, path, `expected integer, got ${JSON.stringify(value).slice(0, 20)}`);
            break;
        case 'number':
            if (typeof value !== 'number') note(ctx.endpoint, schemaName, path, `expected number, got ${typeof value}`);
            break;
        case 'boolean':
            if (typeof value !== 'boolean') note(ctx.endpoint, schemaName, path, `expected boolean, got ${typeof value}`);
            break;
        case 'array':
            if (!Array.isArray(value)) return note(ctx.endpoint, schemaName, path, 'expected array');
            value.forEach((item, i) => validate(item, schema.items, `${path}[${i}]`, { ...ctx, schemaName }));
            break;
        case 'object':
        default:
            if (typeof value !== 'object' || Array.isArray(value)) return note(ctx.endpoint, schemaName, path, 'expected object');
            for (const req of schema.required || []) {
                if (!(req in value)) note(ctx.endpoint, schemaName, `${path}.${req}`, 'required field missing');
            }
            // The Kotlin SDK (Wholphin) treats every non-nullable property as required. Id and Type on items are the ones
            // that matter in practice, so report those as errors and the rest only with STRICT=1.
            for (const [key, sub] of Object.entries(schema.properties || {})) {
                if (key in value) continue;
                const { nullable: subNullable } = resolve(sub);
                const important = (schemaName === 'BaseItemDto' && (key === 'Id' || key === 'Type')) || (schemaName === 'UserItemDataDto' && (key === 'Key' || key === 'ItemId'));
                if (!subNullable && (important || process.env.STRICT)) note(ctx.endpoint, schemaName, `${path}.${key}`, 'non-nullable property missing');
            }
            for (const [key, sub] of Object.entries(schema.properties || {})) {
                if (key in value) validate(value[key], sub, `${path}.${key}`, { ...ctx, schemaName });
            }
            if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
                for (const [key, v] of Object.entries(value)) validate(v, schema.additionalProperties, `${path}.${key}`, { ...ctx, schemaName });
            }
    }
};

let token = null;
const authHeader = () =>
    `MediaBrowser Client="Wholphin", Device="contract-check", DeviceId="5c0ffee5-0000-4000-8000-00000000c0de", Version="1.0"${token ? `, Token="${token}"` : ''}`;

const call = async (label, method, path, body, schemaName, { quiet = false } = {}) => {
    const res = await fetch(PROXY + path, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
    const ok = res.status >= 200 && res.status < 300;
    if (!quiet) console.log(`${String(res.status).padEnd(4)} ${label}`);
    if (!ok) note(label, '-', '', `HTTP ${res.status}`);
    else if (schemaName && json !== undefined) validate(json, { $ref: `#/components/schemas/${schemaName}` }, '$', { endpoint: label, schemaName });
    else if (schemaName && json === undefined) note(label, schemaName, '', 'empty or non-JSON body');
    return json;
};

(async () => {
    spec = process.env.OPENAPI_FILE
        ? JSON.parse(fs.readFileSync(process.env.OPENAPI_FILE, 'utf8'))
        : await (await fetch(SPEC_URL)).json();
    console.log(`Schema: Jellyfin API ${spec.info.version}; proxy: ${PROXY}\n`);

    await call('GET /System/Info/Public', 'GET', '/System/Info/Public', null, 'PublicSystemInfo');
    await call('GET /Users/Public', 'GET', '/Users/Public', null, null);
    const auth = await call('POST /Users/AuthenticateByName', 'POST', '/Users/AuthenticateByName', { Username: USER, Pw: PASS }, 'AuthenticationResult');
    if (!auth || !auth.AccessToken) { console.error('login failed'); process.exit(2); }
    token = auth.AccessToken;
    const uid = auth.User.Id;

    await call('GET /Users/Me', 'GET', '/Users/Me', null, 'UserDto');
    await call('GET /System/Info', 'GET', '/System/Info', null, 'SystemInfo');
    await call('GET /DisplayPreferences/default', 'GET', `/DisplayPreferences/default?userId=${uid}&client=Wholphin`, null, 'DisplayPreferencesDto');
    await call('GET /Sessions', 'GET', `/Sessions?deviceId=x`, null, null);
    await call('GET /Branding/Configuration', 'GET', '/Branding/Configuration', null, 'BrandingOptionsDto');

    const views = await call('GET /UserViews', 'GET', `/UserViews?userId=${uid}`, null, 'BaseItemDtoQueryResult');
    await call('GET /UserItems/Resume', 'GET', `/UserItems/Resume?userId=${uid}&limit=25&mediaTypes=Video&enableUserData=true`, null, 'BaseItemDtoQueryResult');
    await call('GET /Shows/NextUp', 'GET', `/Shows/NextUp?userId=${uid}&limit=25&enableUserData=true`, null, 'BaseItemDtoQueryResult');

    const sample = {};
    const pick = async (type, extra = '') => {
        const r = await call(`GET /Items (${type})`, 'GET', `/Items?userId=${uid}&includeItemTypes=${type}&recursive=true&limit=3&fields=Overview&fields=MediaSources&fields=MediaStreams&fields=People&fields=Genres&fields=Chapters&fields=ProviderIds&fields=ExternalUrls${extra}`, null, 'BaseItemDtoQueryResult');
        sample[type] = r && r.Items && r.Items[0];
        return r;
    };
    for (const t of ['Movie', 'Series', 'Season', 'Episode', 'BoxSet', 'Person', 'MusicArtist', 'MusicAlbum', 'Audio', 'Photo', 'Playlist']) {
        await pick(t);
    }
    for (const v of (views && views.Items) || []) {
        await call(`GET /Items (view ${v.Name})`, 'GET', `/Items?userId=${uid}&parentId=${v.Id}&limit=5&sortBy=SortName&fields=Overview`, null, 'BaseItemDtoQueryResult');
        await call(`GET /Items/Latest (view ${v.Name})`, 'GET', `/Items/Latest?userId=${uid}&parentId=${v.Id}&limit=5&fields=Overview`, null, null);
        const latest = await call(`GET /Items/Latest (view ${v.Name})`, 'GET', `/Items/Latest?userId=${uid}&parentId=${v.Id}&limit=5&groupItems=true`, null, null, { quiet: true });
        if (Array.isArray(latest)) latest.forEach((item, i) => validate(item, { $ref: '#/components/schemas/BaseItemDto' }, `$[${i}]`, { endpoint: `GET /Items/Latest (view ${v.Name})`, schemaName: 'BaseItemDto' }));
    }
    for (const [type, item] of Object.entries(sample)) {
        if (!item) continue;
        const id = item.Id;
        await call(`GET /Items/{id} (${type})`, 'GET', `/Items/${id}?userId=${uid}`, null, 'BaseItemDto');
        await call(`GET /Items/{id}/Similar (${type})`, 'GET', `/Items/${id}/Similar?userId=${uid}&limit=5`, null, 'BaseItemDtoQueryResult');
        await call(`GET /Items/{id}/ThemeSongs (${type})`, 'GET', `/Items/${id}/ThemeSongs?inheritFromParent=false`, null, 'ThemeMediaResult');
        await call(`GET /Items/{id}/SpecialFeatures (${type})`, 'GET', `/Items/${id}/SpecialFeatures?userId=${uid}`, null, null);
        await call(`GET /Items/{id}/LocalTrailers (${type})`, 'GET', `/Items/${id}/LocalTrailers?userId=${uid}`, null, null);
        if (['Movie', 'Episode', 'Audio'].includes(type)) {
            await call(`POST /Items/{id}/PlaybackInfo (${type})`, 'POST', `/Items/${id}/PlaybackInfo?userId=${uid}`, { DeviceProfile: {} }, 'PlaybackInfoResponse');
            await call(`GET /MediaSegments/{id} (${type})`, 'GET', `/MediaSegments/${id}`, null, 'MediaSegmentDtoQueryResult');
        }
        if (type === 'Series') {
            await call('GET /Shows/{id}/Seasons', 'GET', `/Shows/${id}/Seasons?userId=${uid}&fields=Overview`, null, 'BaseItemDtoQueryResult');
            await call('GET /Shows/{id}/Episodes', 'GET', `/Shows/${id}/Episodes?userId=${uid}&fields=Overview&fields=MediaSources`, null, 'BaseItemDtoQueryResult');
            await call('GET /Shows/NextUp?seriesId', 'GET', `/Shows/NextUp?userId=${uid}&seriesId=${id}`, null, 'BaseItemDtoQueryResult');
        }
        if (type === 'Season') {
            await call('GET /Shows/{series}/Episodes?seasonId', 'GET', `/Shows/${item.SeriesId}/Episodes?userId=${uid}&seasonId=${id}`, null, 'BaseItemDtoQueryResult');
        }
    }
    const firstView = views && views.Items && views.Items[0];
    if (firstView) {
        await call('GET /Years', 'GET', `/Years?userId=${uid}&parentId=${firstView.Id}&sortBy=SortName&sortOrder=Ascending`, null, 'BaseItemDtoQueryResult');
        await call('GET /Items/Filters', 'GET', `/Items/Filters?userId=${uid}&parentId=${firstView.Id}`, null, 'QueryFiltersLegacy');
    }
    // Mutations (each is reverted): favorite and played toggles must answer with a complete UserItemDataDto.
    if (sample.Movie) {
        const mid = sample.Movie.Id;
        await call('POST /UserFavoriteItems/{id}', 'POST', `/UserFavoriteItems/${mid}?userId=${uid}`, null, 'UserItemDataDto');
        await call('DELETE /UserFavoriteItems/{id}', 'DELETE', `/UserFavoriteItems/${mid}?userId=${uid}`, null, 'UserItemDataDto');
        await call('POST /UserPlayedItems/{id}', 'POST', `/UserPlayedItems/${mid}?userId=${uid}&datePlayed=${encodeURIComponent(new Date().toISOString())}`, null, 'UserItemDataDto');
        await call('DELETE /UserPlayedItems/{id}', 'DELETE', `/UserPlayedItems/${mid}?userId=${uid}`, null, 'UserItemDataDto');
    }
    await call('GET /Genres', 'GET', `/Genres?userId=${uid}&limit=10&includeItemTypes=Movie`, null, 'BaseItemDtoQueryResult');
    await call('GET /Studios', 'GET', `/Studios?userId=${uid}&limit=10`, null, 'BaseItemDtoQueryResult');
    await call('GET /Persons', 'GET', `/Persons?userId=${uid}&limit=10`, null, 'BaseItemDtoQueryResult');
    await call('GET /Search/Hints', 'GET', `/Search/Hints?userId=${uid}&searchTerm=the&limit=10`, null, 'SearchHintResult');
    await call('GET /Items (search)', 'GET', `/Items?userId=${uid}&searchTerm=the&recursive=true&limit=10&includeItemTypes=Movie&includeItemTypes=Series`, null, 'BaseItemDtoQueryResult');
    await call('GET /Items (favorites)', 'GET', `/Items?userId=${uid}&filters=IsFavorite&recursive=true&limit=10`, null, 'BaseItemDtoQueryResult');
    await call('GET /Items (played)', 'GET', `/Items?userId=${uid}&filters=IsPlayed&recursive=true&limit=10`, null, 'BaseItemDtoQueryResult');
    await call('GET /Items (unplayed sorted)', 'GET', `/Items?userId=${uid}&filters=IsUnplayed&sortBy=DateCreated&sortOrder=Descending&recursive=true&limit=10&includeItemTypes=Movie`, null, 'BaseItemDtoQueryResult');
    await call('GET /Items (random)', 'GET', `/Items?userId=${uid}&sortBy=Random&recursive=true&limit=10&includeItemTypes=Movie`, null, 'BaseItemDtoQueryResult');

    // ---- report ----
    console.log('\n==== Contract violations ====');
    if (findings.size === 0) { console.log('none'); return; }
    const rows = [...findings].sort((a, b) => b[1].count - a[1].count);
    for (const [key, { count }] of rows) console.log(`${String(count).padStart(5)}x  ${key}`);
    process.exitCode = 1;
})().catch((err) => { console.error(err); process.exit(2); });
