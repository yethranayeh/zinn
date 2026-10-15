---
layout: ../layouts/InfoLayout.astro
title: Privacy | Zinn website and local CLI data
description: How zinn.sh uses Cloudflare and Umami, how Do Not Track affects analytics, and where the Zinn CLI stores projects and tasks.
---

# Privacy

This page describes the data handling configured for zinn.sh and distinguishes visits to this website from work stored by the local Zinn CLI.

## Website hosting

Cloudflare serves zinn.sh.

Requests pass through Cloudflare's network, which receives request information such as the visitor's IP address, requested URL and browser headers to deliver the site. See [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/) for its handling of personal information.

Links to GitHub, npm and social profiles take you to those services, whose own policies apply when you visit them.

## Website analytics

The website loads Umami to measure pageviews and successful installation-command copies, plus clicks on GitHub, npm, Twitter and Bluesky links. These events measure website interest. The custom click and copy events carry an event name without additional custom data, and pageviews are handled by the Umami tracker.

The tracker is configured for the zinn.sh domain and to respect the browser's **Do Not Track** setting. Custom events also check that setting before sending. See [Umami's privacy policy](https://umami.is/privacy) for information about the provider.

## Local CLI data

Zinn stores projects, tasks, comments and activity in a local SQLite database. The default path is `~/.zinn/data/zinn.sqlite`. Storage settings or `ZINN_DIR` can select another directory. Visiting this website does not give it access to that database. Installing the CLI involves your package manager and the package registry.

Database files and backups can contain private work. Choose what you share when asking for support, and remove sensitive content from public issue reports. Read [Contact](/contact) for the reporting channel and the [CLI reference](https://github.com/yethranayeh/zinn/blob/main/packages/cli/README.md) for storage and backup settings.
