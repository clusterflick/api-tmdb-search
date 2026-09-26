# api-tmdb-search

A Cloudflare Worker that lets signed-in Clusterflick readers look up films on
[TheMovieDB](https://www.themoviedb.org/), so they can add films that aren't
showing to their watchlist or seen list.

It runs on the route `clusterflick.com/api/tmdb/*`, same-origin with the site,
so the browser needs no CORS. It is not a general TMDB proxy: it answers one
kind of request, builds every TMDB URL itself, and keeps the TMDB token
server-side. It only looks films up; lists are written to Firestore by the
site.

## API

Two endpoints, both calling TMDB's `/3/search/movie`. Every request needs a
Firebase ID token for the site's project, from an account with a verified
email: `Authorization: Bearer <token>`.

Films come back trimmed to what the site uses, with absent fields left out:

```json
{
  "id": "438631",
  "title": "Dune",
  "originalTitle": "…only when it differs",
  "year": "2021",
  "releaseDate": "2021-09-15",
  "posterPath": "/d5NXSklXo0qyIYkgV94XAgMIckC.jpg",
  "overview": "…"
}
```

### `GET /api/tmdb/search`

For the site's film search.

| Param  | Rule                                       |
| ------ | ------------------------------------------ |
| `q`    | Required, 1–100 characters after trimming  |
| `year` | Optional, 4 digits                         |
| `page` | Optional, 1–5, default 1 (20 films a page) |

Returns `{ page, totalPages, totalResults, results }`, with `totalPages` capped
at 5. Responses are cached for an hour, keyed on the normalised request (query
lowercased, whitespace collapsed, params sorted).

### `POST /api/tmdb/match`

For imports: finds the TMDB film for each of up to 15 titles, as Letterboxd
names them.

```json
{ "films": [{ "title": "Amélie", "year": 2001 }, { "title": "Heat" }] }
```

Titles are 1–200 characters; `year` is optional. Returns
`{ "results": [film | null, …] }` in the order asked. Each film is searched
with its year as TMDB's `year`, which takes any release that year, because
Letterboxd dates a film by its first showing, festival premieres included,
and TMDB by its first release after them (Starve Acre is 2023 on Letterboxd,
2024 on TMDB). Matching is strict: a result whose title or original title
matches once case, accents and punctuation are folded away, dated the year
given or later, never earlier, which would be a re-release; or else the only
result, dated the year given (which is how "Harry Potter and the Sorcerer's
Stone" finds the UK title). A miss is `null`. If any search fails the whole
batch is a 502, so a film TMDB couldn't be asked about is never reported as
missing.

Each film's answer is cached for a week (a day for a miss), keyed on its
folded title and year, so re-importing a file costs almost nothing. 15 is the
most a batch can hold on Workers Free, whose 50 subrequests a request include
cache reads and writes.

### Errors and limits

Requests are checked in order and fail at the first problem:

| Status | Meaning                                                   |
| ------ | --------------------------------------------------------- |
| 404    | Any other path                                            |
| 405    | The wrong method: search is `GET`, match is `POST`        |
| 400    | Bad params or body                                        |
| 401    | Missing, invalid or expired token                         |
| 403    | Email not verified                                        |
| 429    | Over the endpoint's per-user limit, or 60 requests per IP |
| 502    | TMDB failed or couldn't be reached                        |

Each endpoint has its own per-user limit, so an import can't lock a reader out
of searching: 30 searches a minute, and 13 match batches a minute (about 195
films). Both share the IP limit. Limits are per Cloudflare location and
approximate. Cached answers are shared between users, and the cache sits after
auth and rate limiting, so they still count against the limits.

## Development

```sh
npm install
cp .dev.vars.example .dev.vars   # add a TMDB read access token
npm run dev                      # http://localhost:8787
npm test
npm run lint
```

After changing `wrangler.jsonc`, run `npm run cf-typegen` and commit
`worker-configuration.d.ts`.

## Deployment

`.github/workflows/deploy.yml` lints and tests every push and pull request,
and deploys on pushes to `main`. The TMDB token is a secret stored on the
Worker: it persists across deploys and never goes in the repo or CI.

### First deploy

CI can't create the Worker. `wrangler.jsonc` marks `TMDB_TOKEN` as required,
so wrangler refuses to deploy a new Worker without it, and
`wrangler secret put` only works on a Worker that already exists. The first
deploy is from a machine with the token, which creates the Worker and its
secret together:

```sh
cp .dev.vars.example .dev.vars   # add the TMDB read access token
npx wrangler login
npx wrangler deploy --secrets-file .dev.vars
```

Then add the repository secrets `CLOUDFLARE_API_TOKEN` (the "Edit Cloudflare
Workers" template, scoped to the account and the `clusterflick.com` zone) and
`CLOUDFLARE_ACCOUNT_ID`, and CI deploys from then on.

The rate limit `namespace_id`s must be unique within the Cloudflare account.

### Rotating the TMDB token

```sh
npx wrangler secret put TMDB_TOKEN
```

## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.

## License

[MIT](LICENSE)
