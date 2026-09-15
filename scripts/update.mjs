import fs from 'node:fs/promises';
import path from 'node:path';

const COUNTRY = process.env.COUNTRY || 'US';
const LANGUAGE = process.env.LANGUAGE || 'en';
const TARGET = Math.max(100, Math.min(1500, Number(process.env.TARGET || 750)));
const PAGE_SIZE = Math.max(25, Math.min(100, Number(process.env.PAGE_SIZE || 100)));
const RECENT_TARGET = Math.min(TARGET, Math.max(100, Number(process.env.RECENT_TARGET || 300)));
const REQUEST_DELAY_MS = Math.max(0, Number(process.env.REQUEST_DELAY_MS || 120));
const TMDB_TOKEN = String(process.env.TMDB_TOKEN || '').trim();
const TMDB_CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.TMDB_CONCURRENCY || 8)));
const TMDB_CACHE_TTL_MS = Math.max(1, Number(process.env.TMDB_CACHE_TTL_DAYS || 30)) * 24 * 60 * 60 * 1000;
const TMDB_MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TMDB_CACHE_PATH = path.join('data', 'tmdb-cache.json');
const ART = 'https://cdn.jsdelivr.net/gh/rinongit/ImgCo@main/StreamCov';

const providers = [
  { key: 'netflix', name: 'Netflix', code: 'nfx', aliases: ['Netflix'], art: `${ART}/NetflixC.png` },
  { key: 'prime', name: 'Prime Video', code: 'amp', aliases: ['Amazon Prime Video', 'Prime Video', 'Amazon Prime'], art: `${ART}/PrimeVideoC.png` },
  { key: 'disney', name: 'Disney+', code: 'dnp', aliases: ['Disney Plus', 'Disney+'], art: `${ART}/DiscneyC.png` },
  { key: 'max', name: 'Max / HBO', code: 'hbm', aliases: ['HBO Max', 'Max'], art: `${ART}/HBOTrans.png` },
  { key: 'apple', name: 'Apple TV+', code: 'atp', aliases: ['Apple TV Plus', 'Apple TV+'], art: `${ART}/AppleC.png` },
  { key: 'paramount', name: 'Paramount+', code: 'pmp', aliases: ['Paramount Plus', 'Paramount+'], art: `${ART}/ParamountC.png` },
  { key: 'peacock', name: 'Peacock', code: 'pcp', aliases: ['Peacock Premium', 'Peacock'], art: `${ART}/Peacock40.png` },
  { key: 'hulu', name: 'Hulu', code: 'hlu', aliases: ['Hulu'], art: `${ART}/Hulu.png` },
  { key: 'crunchyroll', name: 'Crunchyroll', code: 'cru', aliases: ['Crunchyroll'], art: `${ART}/CrunchyrollC.png` },
];

const query = `query GetPopularTitles(
  $country: Country!
  $popularTitlesFilter: TitleFilter
  $popularAfterCursor: String
  $popularTitlesSortBy: PopularTitlesSorting! = POPULAR
  $first: Int!
  $language: Language!
  $offset: Int = 0
  $sortRandomSeed: Int! = 0
  $profile: PosterProfile
  $format: ImageFormat
) {
  popularTitles(
    country: $country
    filter: $popularTitlesFilter
    offset: $offset
    after: $popularAfterCursor
    sortBy: $popularTitlesSortBy
    first: $first
    sortRandomSeed: $sortRandomSeed
  ) {
    totalCount
    pageInfo {
      endCursor
      hasNextPage
    }
    edges {
      cursor
      node {
        content(country: $country, language: $language) {
          externalIds { imdbId }
          title
          originalReleaseYear
          posterUrl(profile: $profile, format: $format)
        }
      }
    }
  }
}`;

const packagesQuery = `query GetPackages($country: Country!, $platform: Platform!) {
  packages(country: $country, platform: $platform) {
    shortName
    clearName
  }
}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function fetchPackages() {
  const response = await fetch('https://apis.justwatch.com/graphql', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 OdinCollections/3.5',
    },
    body: JSON.stringify({
      operationName: 'GetPackages',
      variables: { country: COUNTRY, platform: 'WEB' },
      query: packagesQuery,
    }),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`JustWatch packages HTTP ${response.status}: ${text.slice(0, 220)}`);
  const json = JSON.parse(text);
  if (json.errors?.length) throw new Error(`JustWatch packages: ${json.errors[0].message}`);
  return Array.isArray(json?.data?.packages) ? json.data.packages : [];
}

function resolveProviderCodes(packages) {
  for (const provider of providers) {
    const aliases = provider.aliases.map(norm);
    let match = packages.find((pkg) => aliases.includes(norm(pkg?.clearName)));

    if (!match && provider.key === 'max') {
      match = packages.find((pkg) => {
        const name = norm(pkg?.clearName);
        return name.includes('hbo max') && !name.includes('amazon');
      });
    }

    if (match?.shortName) {
      const old = provider.code;
      provider.code = match.shortName;
      console.log(`${provider.name} provider code: ${old} -> ${provider.code} (${match.clearName})`);
    } else {
      console.log(`${provider.name} provider code: using fallback ${provider.code}`);
    }
  }
}

function toVideo(content) {
  const imdb = content?.externalIds?.imdbId;
  if (!imdb || !/^tt\d+$/.test(imdb)) return null;
  const posterId = content?.posterUrl?.match(/\/poster\/(\d+)\//)?.[1];
  return {
    id: imdb,
    title: content?.title || imdb,
    thumbnail: posterId
      ? `https://images.justwatch.com/poster/${posterId}/s332/img`
      : `https://live.metahub.space/poster/medium/${imdb}/img`,
    released: content?.originalReleaseYear ? `${content.originalReleaseYear}-01-01` : undefined,
  };
}

async function fetchPage(provider, sortBy, after) {
  const body = {
    operationName: 'GetPopularTitles',
    variables: {
      popularTitlesSortBy: sortBy,
      first: PAGE_SIZE,
      platform: 'WEB',
      sortRandomSeed: 0,
      popularAfterCursor: after || '',
      offset: null,
      popularTitlesFilter: {
        ageCertifications: [],
        excludeGenres: [],
        excludeProductionCountries: [],
        genres: [],
        objectTypes: ['MOVIE'],
        productionCountries: [],
        packages: [provider.code],
        excludeIrrelevantTitles: false,
        presentationTypes: [],
        monetizationTypes: [],
      },
      language: LANGUAGE,
      country: COUNTRY,
      profile: null,
      format: null,
    },
    query,
  };

  const response = await fetch('https://apis.justwatch.com/graphql', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 OdinCollections/3.5',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`${provider.name}: JustWatch HTTP ${response.status}: ${text.slice(0, 220)}`);
  const json = JSON.parse(text);
  if (json.errors?.length) throw new Error(`${provider.name}: ${json.errors[0].message}`);

  const result = json?.data?.popularTitles;
  return {
    totalCount: Number(result?.totalCount || 0),
    edges: Array.isArray(result?.edges) ? result.edges : [],
    endCursor: result?.pageInfo?.endCursor || '',
    hasNextPage: Boolean(result?.pageInfo?.hasNextPage),
  };
}

async function addFromSort(provider, sortBy, stopAt, seen, videos) {
  let after = '';
  let pages = 0;

  for (;;) {
    if (videos.length >= stopAt) break;
    const page = await fetchPage(provider, sortBy, after);
    pages += 1;
    if (!page.edges.length) break;

    for (const edge of page.edges) {
      const video = toVideo(edge?.node?.content);
      if (!video || seen.has(video.id)) continue;
      seen.add(video.id);
      videos.push(video);
      if (videos.length >= stopAt) break;
    }

    if (!page.hasNextPage || !page.endCursor || page.endCursor === after) break;
    after = page.endCursor;
    if (REQUEST_DELAY_MS) await sleep(REQUEST_DELAY_MS);
    if (pages >= 30) break;
  }
}

async function fetchProvider(provider) {
  const seen = new Set();
  const videos = [];

  await addFromSort(provider, 'RELEASE_YEAR', RECENT_TARGET, seen, videos);
  if (videos.length < TARGET) {
    await addFromSort(provider, 'POPULAR', TARGET, seen, videos);
  }

  return videos.slice(0, TARGET);
}

async function loadTmdbCache() {
  try {
    return JSON.parse(await fs.readFile(TMDB_CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function saveTmdbCache(cache) {
  await fs.mkdir(path.dirname(TMDB_CACHE_PATH), { recursive: true });
  const ordered = Object.fromEntries(Object.entries(cache).sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile(TMDB_CACHE_PATH, `${JSON.stringify(ordered, null, 2)}\n`);
}

function cacheIsFresh(entry) {
  const checkedAt = Number(entry?.checkedAt || 0);
  if (!checkedAt) return false;
  const ttl = entry?.missing ? TMDB_MISS_TTL_MS : TMDB_CACHE_TTL_MS;
  return Date.now() - checkedAt < ttl;
}

async function fetchTmdbMeta(imdbId) {
  const url = new URL(`https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}`);
  url.searchParams.set('external_source', 'imdb_id');
  url.searchParams.set('language', 'en-US');

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${TMDB_TOKEN}`,
      'user-agent': 'OdinCollections/3.5',
    },
  });

  if (response.status === 429) {
    const retryAfter = Math.max(1, Number(response.headers.get('retry-after') || 1));
    await sleep(retryAfter * 1000);
    return fetchTmdbMeta(imdbId);
  }

  const text = await response.text();
  if (!response.ok) throw new Error(`TMDB ${imdbId} HTTP ${response.status}: ${text.slice(0, 180)}`);
  const json = JSON.parse(text);
  const movie = Array.isArray(json?.movie_results) ? json.movie_results[0] : null;
  if (!movie) return null;

  return {
    title: movie.title || movie.original_title || imdbId,
    released: /^\d{4}-\d{2}-\d{2}$/.test(movie.release_date || '') ? movie.release_date : undefined,
    thumbnail: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : undefined,
  };
}

async function enrichFromTmdb(providerResults) {
  if (!TMDB_TOKEN) {
    console.log('TMDB_TOKEN not configured; keeping JustWatch title/year metadata.');
    return;
  }

  const cache = await loadTmdbCache();
  const unique = new Map();
  for (const result of providerResults) {
    for (const video of result.videos) {
      if (!unique.has(video.id)) unique.set(video.id, video);
    }
  }

  const ids = [...unique.keys()];
  let cursor = 0;
  let fetched = 0;
  let cacheHits = 0;
  let misses = 0;
  let failures = 0;

  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= ids.length) return;
      const imdbId = ids[index];
      let entry = cache[imdbId];

      if (cacheIsFresh(entry)) {
        cacheHits += 1;
      } else {
        try {
          const meta = await fetchTmdbMeta(imdbId);
          entry = meta
            ? { ...meta, checkedAt: Date.now() }
            : { missing: true, checkedAt: Date.now() };
          cache[imdbId] = entry;
          fetched += 1;
          if (entry.missing) misses += 1;
        } catch (error) {
          failures += 1;
          console.error(`TMDB lookup failed for ${imdbId}: ${error.message}`);
          continue;
        }
      }

      if (!entry?.missing) {
        const source = unique.get(imdbId);
        if (entry.title) source.title = entry.title;
        if (entry.released) source.released = entry.released;
        if (entry.thumbnail) source.thumbnail = entry.thumbnail;
      }
    }
  }

  await Promise.all(Array.from({ length: TMDB_CONCURRENCY }, () => worker()));
  await saveTmdbCache(cache);
  console.log(`TMDB metadata: ${unique.size} unique IDs, ${cacheHits} cache hits, ${fetched} fetched, ${misses} not found, ${failures} failures`);
}

const versions = [
  { prefix: 'odincol', base: path.join('meta', 'movie') },
  { prefix: 'odincol2', base: path.join('v2', 'meta', 'movie') },
  { prefix: 'odincol3', base: path.join('v3', 'meta', 'movie') },
];

for (const version of versions) {
  await fs.mkdir(version.base, { recursive: true });
}

try {
  const packages = await fetchPackages();
  resolveProviderCodes(packages);
} catch (error) {
  console.error(`Provider-code refresh failed; using fallbacks: ${error.message}`);
}

const providerResults = [];
const summary = [];

for (const provider of providers) {
  try {
    const videos = await fetchProvider(provider);
    if (!videos.length) throw new Error('No IMDb movie IDs returned');
    providerResults.push({ provider, videos });
  } catch (error) {
    console.error(`Failed ${provider.name}:`, error.message);
    summary.push(`${provider.name}: kept previous data`);
  }
}

if (!providerResults.length) {
  throw new Error('All provider refreshes failed; refusing to publish an empty update.');
}

await enrichFromTmdb(providerResults);

for (const { provider, videos } of providerResults) {
  for (const version of versions) {
    const itemKey = version.prefix === 'odincol2' && provider.key === 'max' ? 'hbomax' : provider.key;
    const payload = {
      meta: {
        id: `${version.prefix}.${itemKey}`,
        type: 'movie',
        name: provider.name,
        description: `${provider.name} recent and popular movies available in ${COUNTRY}. Provider membership from JustWatch; title, release date and poster enriched from TMDB when available.`,
        poster: provider.art,
        background: provider.art,
        posterShape: 'landscape',
        videos,
      },
    };
    await fs.writeFile(path.join(version.base, `${version.prefix}.${itemKey}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  }

  summary.push(`${provider.name}: ${videos.length}`);
}

console.log(summary.join('\n'));
