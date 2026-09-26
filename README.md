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

One endpoint, `GET /api/tmdb/search`, which calls TMDB's `/3/search/movie`.
Every request needs a Firebase ID token for the site's project, from an account
with a verified email: `Authorization: Bearer <token>`.

| Param  | Rule                                       |
| ------ | ------------------------------------------ |
| `q`    | Required, 1–100 characters after trimming  |
| `year` | Optional, 4 digits                         |
| `page` | Optional, 1–5, default 1 (20 films a page) |

It returns `{ page, totalPages, totalResults, results }`, with `totalPages`
capped at 5. Each film is trimmed to what the site uses, with absent fields
left out:

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

Requests are checked in order and fail at the first problem:

| Status | Meaning                                          |
| ------ | ------------------------------------------------ |
| 404    | Any path but the search                          |
| 405    | Not `GET`                                        |
| 400    | Bad params                                       |
| 401    | Missing, invalid or expired token                |
| 403    | Email not verified                               |
| 429    | Over 30 requests a minute per user, or 60 per IP |
| 502    | TMDB failed or couldn't be reached               |

Responses are cached for an hour and shared between users in the Cache API,
keyed on the normalised request (query lowercased, whitespace collapsed, params
sorted). The cache sits after auth and rate limiting, so cached answers still
count against the limits. Rate limits are per Cloudflare location and
approximate.

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
and deploys on pushes to `main`. One-off setup:

- Repository secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts edit and Workers
  Routes edit on the `clusterflick.com` zone) and `CLOUDFLARE_ACCOUNT_ID`.
- The TMDB token, as a Worker secret: `npx wrangler secret put TMDB_TOKEN`. It
  persists across deploys and never goes in the repo or CI.
- The rate limit `namespace_id`s must be unique within the Cloudflare account.

## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.

## License

[MIT](LICENSE)
