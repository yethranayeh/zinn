# zinn.sh

Website of Zinn.

---

Fonts, the favicon and Pixelarticons SVGs are self-hosted, and their attribution and license information are in `public/fonts/` and `public/pixelarticons-LICENSE.txt`.

## Builds and indexing

`bun run docs:build` from the repository root creates a preview build. Preview and local pages carry `noindex` and omit analytics. To build for the production domain, use:

```sh
PUBLIC_SITE_ENV=production bun run docs:build
```

Set `PUBLIC_SITE_ENV=production` only in the production deployment environment, and leave it unset for hosted previews. These values are baked into static HTML and scripts, so each environment needs its own build.

Canonical and social URLs always use `https://zinn.sh/`. Astro's [sitemap integration](https://docs.astro.build/en/guides/integrations-guide/sitemap/) includes public pages and excludes the 404. Production `robots.txt` advertises the sitemap. Preview robots allow crawling so search engines can read the HTML [`noindex` rule](https://developers.google.com/search/docs/crawling-indexing/block-indexing). The 404 always carries `noindex`, has no canonical, and provides a link home. The host must serve `404.html` for missing routes with HTTP status 404.

The shared layout emits Open Graph and Twitter metadata using `public/social/zinn.png`, and the homepage includes factual `WebSite` structured data. The social image uses the self-hosted Alan Sans and MonoMMM fonts.

## Analytics

Only builds with `PUBLIC_SITE_ENV=production` include the Umami Cloud script and website ID. Custom events also require the `zinn.sh` hostname and respect **Do Not Track**. The tracker uses the same domain and DNT restrictions.

Automatic pageviews, `github-click`, `npm-click` and `install-copy` are the only configured tracking. Link events use one browser listener each. Events carry no custom data and measure interest.

Configuration follows Umami's [tracker configuration](https://docs.umami.is/docs/tracker-configuration) and [event API](https://docs.umami.is/docs/tracker-functions).
