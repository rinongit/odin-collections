import fs from 'node:fs/promises';
import path from 'node:path';

const COUNTRY = process.env.COUNTRY || 'US';
const LANGUAGE = process.env.LANGUAGE || 'en';
const TARGET = Math.max(100, Math.min(1500, Number(process.env.TARGET || 750)));
const PAGE_SIZE = Math.max(25, Math.min(100, Number(process.env.PAGE_SIZE || 100)));
const RECENT_TARGET = Math.min(TARGET, Math.max(100, Number(process.env.RECENT_TARGET || 300)));
const REQUEST_DELAY_MS = Math.max(0, Number(process.env.REQUEST_DELAY_MS || 120));
const ART = 'https://cdn.jsdelivr.net/gh/rinongit/ImgCo@main/StreamCov';

const providers = [
  { key: 'netflix', name: 'Netflix', code: 'nfx', art: `${ART}/NetflixC.png` },
  { key: 'prime', name: 'Prime Video', code: 'amp', art: `${ART}/PrimeVideoC.png` },
  { key: 'disney', name: 'Disney+', code: 'dnp', art: `${ART}/DiscneyC.png` },
  { key: 'max', name: 'Max / HBO', code: 'hbm', art: `${ART}/HBOTrans.png` },
  { key: 'apple', name: 'Apple TV+', code: 'atp', art: `${ART}/AppleC.png` },
  { key: 'paramount', name: 'Paramount+', code: 'pmp', art: `${ART}/ParamountC.png` },
  { key: 'peacock', name: 'Peacock', code: 'pcp', art: `${ART}/Peacock40.png` },
  { key: 'hulu', name: 'Hulu', code: 'hlu', art: `${ART}/Hulu.png` },
  { key: 'crunchyroll', name: 'Crunchyroll', code: 'cru', art: `${ART}/CrunchyrollC.png` },
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        // Match JustWatch's current provider-catalog query. The package ID
        // already selects the service; leaving monetization unrestricted
        // avoids dropping subscription titles that JustWatch classifies via
        // bundles/add-ons instead of FLATRATE.
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
      'user-agent': 'Mozilla/5.0 OdinCollections/3.2',
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

  // Keep newest releases at the front so newly available movies appear quickly.
  await addFromSort(provider, 'RELEASE_YEAR', RECENT_TARGET, seen, videos);

  // Fill the rest with popular back-catalogue titles.
  if (videos.length < TARGET) {
    await addFromSort(provider, 'POPULAR', TARGET, seen, videos);
  }

  return videos.slice(0, TARGET);
}

await fs.mkdir(path.join('meta', 'movie'), { recursive: true });
await fs.mkdir(path.join('v2', 'meta', 'movie'), { recursive: true });

const summary = [];
let successfulProviders = 0;
for (const provider of providers) {
  try {
    const videos = await fetchProvider(provider);
    if (!videos.length) throw new Error('No IMDb movie IDs returned');

    for (const version of [1, 2]) {
      const prefix = version === 1 ? 'odincol' : 'odincol2';
      const base = version === 1 ? path.join('meta', 'movie') : path.join('v2', 'meta', 'movie');
      const payload = {
        meta: {
          id: `${prefix}.${provider.key}`,
          type: 'movie',
          name: provider.name,
          description: `${provider.name} recent and popular movies available in ${COUNTRY}. Automatically refreshed from JustWatch.`,
          poster: provider.art,
          background: provider.art,
          posterShape: 'landscape',
          videos,
        },
      };
      await fs.writeFile(path.join(base, `${prefix}.${provider.key}.json`), `${JSON.stringify(payload, null, 2)}\n`);
    }

    successfulProviders += 1;
    summary.push(`${provider.name}: ${videos.length}`);
  } catch (error) {
    console.error(`Failed ${provider.name}:`, error.message);
    summary.push(`${provider.name}: kept previous data`);
  }
}

console.log(summary.join('\n'));
if (successfulProviders === 0) {
  throw new Error('All provider refreshes failed; refusing to publish an empty update.');
}
