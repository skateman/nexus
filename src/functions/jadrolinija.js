const { app } = require('@azure/functions');
const { storeFile } = require('../utils/storage');

// ── Constants ────────────────────────────────────────────────────────────────

const RSS_URL = 'https://www.jadrolinija.hr/feeds/vijesti';
const VOYAGER2_BASE = 'https://www2.jadrolinija.hr/voyager2/api';
const AISFRIENDS_BASE = 'https://www.aisfriends.com/api/public/v1';
const FETCH_TIMEOUT_MS = 15000;
const AIS_ACTIVE_THRESHOLD_MS = 3 * 60 * 60 * 1000;

const DISRUPTION_KEYWORDS = [
    'u prekidu', 'otkazano', 'otkazana', 'otkazane',
    'ne plove', 'ne prometuje', 'obustava', 'obustavljen', 'obustavljena',
];

const NORMAL_KEYWORDS = [
    'nema poteškoća', 'nema poteskoća', 'svi brodovi plove', 'prema redu plovidbe',
];

const VESSELS = {
    BOL: { mmsi: '238810440', imo: '8736344' },
    ILOVIK: { mmsi: '238796840', imo: '8736332' },
    KORNATI: { mmsi: '238663140', imo: '9703708' },
    KRK: { mmsi: '238002000', imo: '9703722' },
    BRAC: { mmsi: '238666940', imo: '9703710' },
    CRES: { mmsi: '238238340', imo: '9334741' },
    SUPETAR: { mmsi: '238151740', imo: '9328182' },
};

const ROUTES = [
    {
        name: 'merag_valbiska',
        departurePort: { code: 'MER', type: 'PORT', desc: 'MERAG', typeDesc: 'Luka', countryCode: 'HR', islandName: 'Cres' },
        destinationPort: { code: 'VAL', type: 'PORT', desc: 'VALBISKA', typeDesc: 'Luka', countryCode: 'HR', islandName: null },
        keywords: ['Merag', 'Valbiska', '332', 'linija 332'],
        areaBbox: { minLat: 44.96, maxLat: 45.04, minLon: 14.43, maxLon: 14.51 },
    },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const fetchWithTimeout = async (url, options = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
};

const normalize = (text) => text.replace(/<[^>]+>/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();

const extractTag = (xml, tagName) => {
    const cdataPattern = new RegExp(`<${tagName}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tagName}>`);
    const plainPattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`);
    const match = xml.match(cdataPattern) || xml.match(plainPattern);
    return match ? match[1].trim() : '';
};

// ── RSS Source ────────────────────────────────────────────────────────────────

const checkRss = async (routes, context) => {
    try {
        const response = await fetchWithTimeout(RSS_URL);
        if (!response.ok) throw new Error(`RSS fetch failed: ${response.status}`);
        const xml = await response.text();

        const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
        const text = items.map((item) => {
            return `${extractTag(item, 'title')} ${extractTag(item, 'description')}`.trim();
        }).filter(Boolean).join(' ');

        context.log(`RSS status: "${text.substring(0, 120)}..."`);

        const results = {};
        for (const route of routes) {
            const normalized = normalize(text);
            const isAllClear = NORMAL_KEYWORDS.some((kw) => normalized.includes(normalize(kw)));
            const routeMentioned = route.keywords.some((kw) => normalized.includes(normalize(kw)));
            const hasDisruption = DISRUPTION_KEYWORDS.some((kw) => normalized.includes(normalize(kw)));
            const disrupted = routeMentioned && hasDisruption && (!isAllClear || hasDisruption);

            results[route.name] = {
                disrupted: isAllClear && !disrupted ? false : disrupted,
                text: text.substring(0, 300),
                matchedKeywords: disrupted ? route.keywords.filter((kw) => normalized.includes(normalize(kw))) : [],
            };
        }
        return results;
    } catch (error) {
        context.error(`RSS check failed: ${error.message}`);
        return Object.fromEntries(routes.map((r) => [r.name, { status: 'error', disrupted: null, error: error.message }]));
    }
};

// ── Voyager2 Source ───────────────────────────────────────────────────────────

let voyager2Token = null;
let voyager2TokenExpiresAt = null;

const voyager2Auth = async (context) => {
    const response = await fetchWithTimeout(`${VOYAGER2_BASE}/Auth/Token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            UserName: process.env.VOYAGER2_USERNAME || 'intS',
            DeviceSerialNumber: process.env.VOYAGER2_DEVICE_SERIAL || 'InternetProdaja',
            SessionID: crypto.randomUUID(),
        }),
    });

    if (!response.ok) throw new Error(`Voyager2 auth failed: ${response.status}`);
    const data = await response.json();

    voyager2Token = data.AccessToken;
    voyager2TokenExpiresAt = data.ExpirationTimeUtc
        ? new Date(data.ExpirationTimeUtc + 'Z').getTime() - 60000
        : Date.now() + 9 * 24 * 60 * 60 * 1000;

    context.log('Voyager2: authenticated');
    return voyager2Token;
};

const getVoyager2Token = async (context) => {
    if (voyager2Token && voyager2TokenExpiresAt && Date.now() < voyager2TokenExpiresAt) return voyager2Token;
    return voyager2Auth(context);
};

const searchVoyages = async (route, token) => {
    const localDate = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Zagreb' });
    const response = await fetchWithTimeout(`${VOYAGER2_BASE}/Routes/SearchVoyages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
            DeparturePoint: route.departurePort,
            DestinationPoint: route.destinationPort,
            DepartureDate: `${localDate}T00:00:00`,
            NoOfPassengers: 1, NoOfVehicles: 0, NoOfBikes: 0,
        }),
    });

    if (response.status === 401) {
        voyager2Token = null;
        voyager2TokenExpiresAt = null;
        throw new Error('Voyager2: token expired');
    }
    if (!response.ok) throw new Error(`Voyager2 SearchVoyages failed: ${response.status}`);
    return response.json();
};

const checkVoyager2 = async (routes, context) => {
    let token;
    try {
        token = await getVoyager2Token(context);
    } catch (error) {
        context.error(`Voyager2 auth failed: ${error.message}`);
        return Object.fromEntries(routes.map((r) => [r.name, { status: 'error', disrupted: null, departuresFound: null, error: error.message }]));
    }

    const results = {};
    for (const route of routes) {
        try {
            let data;
            try {
                data = await searchVoyages(route, token);
            } catch (error) {
                if (error.message.includes('token expired')) {
                    token = await voyager2Auth(context);
                    data = await searchVoyages(route, token);
                } else throw error;
            }

            const voyages = Array.isArray(data) ? data : (data.Voyages || data.voyages || []);
            const active = voyages.filter((v) => (v.Status || v.status) == 40);
            const ships = [...new Set(active.map((v) => v.Ship?.ShipName || v.ShipName || null).filter(Boolean))];

            results[route.name] = { disrupted: active.length === 0, departuresFound: active.length, ships };
            context.log(`Voyager2 ${route.name}: ${active.length} departures, ships: ${ships.join(', ')}`);
        } catch (error) {
            context.error(`Voyager2 check failed for ${route.name}: ${error.message}`);
            results[route.name] = { status: 'error', disrupted: null, departuresFound: null, error: error.message };
        }
    }
    return results;
};

// ── AIS Friends Source (cross-references Voyager2 ship assignments) ──────────

// In-memory cache for dynamically discovered vessel MMSIs
const discoveredVessels = {};

// Resolve ship names to MMSIs. For unknown ships, query the bounding box
// to find them by name and cache the MMSI for future runs.
const resolveMMSIs = async (shipNames, route, token, context) => {
    const resolved = [];
    const unknown = [];

    for (const name of shipNames) {
        const key = name.toUpperCase();
        const mmsi = VESSELS[key]?.mmsi || discoveredVessels[key];
        if (mmsi) {
            resolved.push(mmsi);
        } else {
            unknown.push(key);
        }
    }

    // For unknown ships, scan the route area and match by name
    if (unknown.length > 0 && route.areaBbox) {
        try {
            const bbox = route.areaBbox;
            const response = await fetchWithTimeout(
                `${AISFRIENDS_BASE}/vessels/bounding-box?lat_min=${bbox.minLat}&lat_max=${bbox.maxLat}&lon_min=${bbox.minLon}&lon_max=${bbox.maxLon}`, {
                    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
                }
            );

            if (response.ok) {
                const areaVessels = await response.json();
                for (const v of (Array.isArray(areaVessels) ? areaVessels : [])) {
                    const vName = (v.name || '').toUpperCase();
                    if (unknown.includes(vName) && v.mmsi) {
                        discoveredVessels[vName] = String(v.mmsi);
                        resolved.push(String(v.mmsi));
                        context.log(`AIS Friends: discovered ${vName} → MMSI ${v.mmsi}`);
                    }
                }
            }

            const stillUnknown = unknown.filter((n) => !discoveredVessels[n]);
            if (stillUnknown.length > 0) {
                context.log(`AIS Friends: could not resolve MMSIs for: ${stillUnknown.join(', ')}`);
            }
        } catch (error) {
            context.log(`AIS Friends: bounding box lookup failed: ${error.message}`);
        }
    }

    return resolved;
};

const checkAisFriends = async (routes, context, voyager2Data = {}) => {
    const token = process.env.AISFRIENDS_TOKEN;
    if (!token) {
        context.log('AIS Friends: no token configured, skipping');
        return Object.fromEntries(routes.map((r) => [r.name, { status: 'disabled', disrupted: null }]));
    }

    const results = {};
    for (const route of routes) {
        try {
            const shipNames = voyager2Data[route.name]?.ships || [];
            const mmsiList = await resolveMMSIs(shipNames, route, token, context);

            // If still no MMSIs, fall back to all known vessels
            if (mmsiList.length === 0) mmsiList.push(...Object.values(VESSELS).map((v) => v.mmsi));

            const response = await fetchWithTimeout(
                `${AISFRIENDS_BASE}/vessels/latest-position?mmsi=${mmsiList.join(',')}`, {
                    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
                }
            );
            if (!response.ok) throw new Error(`AIS Friends API failed: ${response.status}`);

            const vessels = await response.json();
            const vesselList = Array.isArray(vessels) ? vessels : [];
            const now = Date.now();

            const vesselStatuses = vesselList.map((v) => {
                const ageMs = now - new Date(v.report_timestamp + 'Z').getTime();
                const onRoute = (v.ais_destination || '').includes('HRVAL') ||
                                (v.ais_destination || '').includes('HRMER') ||
                                (v.last_port_locode || '').includes('HRVAL') ||
                                (v.last_port_locode || '').includes('HRMRG');

                return {
                    name: v.name, mmsi: v.mmsi,
                    recentlySeen: ageMs < AIS_ACTIVE_THRESHOLD_MS,
                    ageMinutes: Math.round(ageMs / 60000),
                    onRoute, speed: v.speed_over_ground,
                    destination: v.ais_destination, lastPort: v.last_port,
                };
            });

            const activeOnRoute = vesselStatuses.filter((v) => v.recentlySeen && v.onRoute);
            const anyFreshData = vesselStatuses.some((v) => v.recentlySeen);
            const hour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Europe/Zagreb', hour: 'numeric', hour12: false }));
            const duringService = hour >= 5 && hour < 23;

            // Only flag disruption if we have fresh AIS data AND no vessel is active on route.
            // Stale data = unknown (null), not disrupted.
            const disrupted = vesselStatuses.length === 0 ? null
                : !duringService ? null
                : !anyFreshData ? null
                : activeOnRoute.length === 0;

            results[route.name] = { disrupted, trackedVessels: vesselStatuses, activeOnRoute: activeOnRoute.length };
            context.log(`AIS Friends ${route.name}: ${activeOnRoute.length}/${vesselStatuses.length} vessels active on route`);
        } catch (error) {
            context.error(`AIS Friends check failed for ${route.name}: ${error.message}`);
            results[route.name] = { status: 'error', disrupted: null, error: error.message };
        }
    }
    return results;
};

// ── Main Function ────────────────────────────────────────────────────────────

const jadrolinija = async (myTimer, context) => {
    context.log('Jadrolinija disruption check starting...');

    // RSS + Voyager2 run in parallel; AIS Friends needs Voyager2 ship names
    const [rssResults, voyager2Results] = await Promise.all([
        checkRss(ROUTES, context),
        checkVoyager2(ROUTES, context),
    ]);
    const aisResults = await checkAisFriends(ROUTES, context, voyager2Results);

    const routes = {};
    let allSourcesHealthy = true;

    for (const route of ROUTES) {
        const rss = rssResults[route.name] || { disrupted: null };
        const voyager2 = voyager2Results[route.name] || { disrupted: null };
        const ais = aisResults[route.name] || { disrupted: null };

        if (rss.status === 'error' || voyager2.status === 'error' || ais.status === 'error') allSourcesHealthy = false;

        const sourceResults = [rss.disrupted, voyager2.disrupted, ais.disrupted].filter((v) => v !== null && v !== undefined);
        const disrupted = sourceResults.length > 0 ? sourceResults.some(Boolean) : null;

        const detailParts = [];
        if (rss.disrupted) detailParts.push(`RSS: keywords matched (${rss.matchedKeywords?.join(', ')})`);
        if (rss.status === 'error') detailParts.push(`RSS: ${rss.error}`);
        if (voyager2.disrupted) detailParts.push(`Voyager2: ${voyager2.departuresFound ?? 0} departures found`);
        if (voyager2.status === 'error') detailParts.push(`Voyager2: ${voyager2.error}`);
        if (ais.disrupted) detailParts.push(`AIS: ${ais.activeOnRoute ?? 0}/${ais.trackedVessels?.length ?? 0} vessels active on route`);
        if (ais.status === 'error') detailParts.push(`AIS: ${ais.error}`);

        // Build summary — always populated
        let summary;
        if (disrupted === null) {
            summary = 'All sources failed';
        } else if (disrupted) {
            summary = rss.text || `Disrupted — ${detailParts.join('; ')}`;
        } else {
            const ships = voyager2.ships?.join(', ') || 'unknown';
            const departures = voyager2.departuresFound ?? '?';
            summary = rss.text?.substring(0, 100) || `${ships} — ${departures} departures remaining`;
        }

        routes[route.name] = {
            disrupted,
            summary,
            sources: { rss, voyager2, aisfriends: ais },
            details: detailParts.length > 0 ? detailParts.join('; ') : null,
        };

        context.log(`${route.name}: disrupted=${disrupted}`);
    }

    const status = { lastChecked: new Date().toISOString(), healthy: allSourcesHealthy, routes };
    await storeFile('nexus-results', 'jadrolinija-status.json', Buffer.from(JSON.stringify(status, null, 2), 'utf8'), 'application/json');
    context.log('Jadrolinija status blob updated');
};

// Runs every hour during service hours (4-23 UTC = 5-24 CET / 6-01 CEST)
app.timer('jadrolinija', {
    schedule: '0 0 4-23 * * *',
    handler: jadrolinija,
});
