import fs from 'node:fs/promises';
import path from 'node:path';

const COUNTRY = process.env.COUNTRY || 'US';
const LANGUAGE = process.env.LANGUAGE || 'en';
const LIMIT = Number(process.env.LIMIT || 100);
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

const query = `query GetPopularTitles($country: Country!, $popularTitlesFilter: TitleFilter, $popularAfterCursor: String, $popularTitlesSortBy: PopularTitlesSorting! = RELEASE_YEAR, $first: Int!, $language: Language!, $offset: Int = 0, $sortRandomSeed: Int! = 0, $profile: PosterProfile, $format: ImageFormat) { popularTitles(country: $country, filter: $popularTitlesFilter, offset: $offset, after: $popularAfterCursor, sortBy: $popularTitlesSortBy, first: $first, sortRandomSeed: $sortRandomSeed) { edges { node { content(country: $country, language: $language) { externalIds { imdbId } title originalReleaseYear posterUrl(profile: $profile, format: $format) } } } } }`;

async function fetchProvider(provider) {
  const body = {
    operationName: 'GetPopularTitles',
    variables: {
      popularTitlesSortBy: 'RELEASE_YEAR', first: LIMIT, sortRandomSeed: 0,
      popularAfterCursor: '', offset: null,
      popularTitlesFilter: {
        ageCertifications: [], excludeGenres: [], excludeProductionCountries: [], genres: [],
        objectTypes: ['MOVIE'], productionCountries: [], packages: [provider.code],
        excludeIrrelevantTitles: false, presentationTypes: [], monetizationTypes: ['FLATRATE'],
      },
      language: LANGUAGE, country: COUNTRY, profile: null, format: null,
    },
    query,
  };
  const response = await fetch('https://apis.justwatch.com/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 OdinCollections/2.0' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${provider.name}: JustWatch HTTP ${response.status}`);
  const json = await response.json();
  if (json.errors?.length) throw new Error(`${provider.name}: ${json.errors[0].message}`);
  const seen = new Set();
  const videos = [];
  for (const edge of json?.data?.popularTitles?.edges || []) {
    const content = edge?.node?.content;
    const imdb = content?.externalIds?.imdbId;
    if (!imdb || !/^tt\d+$/.test(imdb) || seen.has(imdb)) continue;
    seen.add(imdb);
    const posterId = content?.posterUrl?.match(/\/poster\/(\d+)\//)?.[1];
    videos.push({
      id: imdb,
      title: content?.title || imdb,
      thumbnail: posterId ? `https://images.justwatch.com/poster/${posterId}/s332/img` : `https://live.metahub.space/poster/medium/${imdb}/img`,
      released: content?.originalReleaseYear ? `${content.originalReleaseYear}-01-01` : undefined,
    });
  }
  return videos;
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
          description: `${provider.name} latest movie releases available in ${COUNTRY}. Automatically refreshed from JustWatch.`,
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
if (successfulProviders === 0) throw new Error('All provider refreshes failed; refusing to publish an empty update.');
