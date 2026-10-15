# zinn.sh

Website of Zinn.

---

Fonts, the favicon and Pixelarticons SVGs are self-hosted, and their attribution and license information are in `public/fonts/` and `public/pixelarticons-LICENSE.txt`.

## Development

Run from the repository root:

```sh
bun run docs:dev
bun run docs:check
bun run docs:build
bun run docs:preview
bun run --cwd docs test
```

Default builds are previews: they carry `noindex` and omit analytics. For a production build, use `PUBLIC_SITE_ENV=production bun run docs:build`.

Builds generate `/social/zinn.png` from the shared installation command and the [social-card component](src/components/SocialCard.ts).

## Deployment

Deploy from the repository root:

```sh
bun run docs:deploy
```

This builds and deploys the production site. Deployment configuration is in [wrangler.jsonc](wrangler.jsonc).
