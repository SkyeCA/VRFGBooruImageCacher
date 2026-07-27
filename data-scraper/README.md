# Data Scraper

Fetches all image posts from the Booru API and writes them to `booru_data.json`.

## Requirements

- Node.js 18+

## Install

```bash
cd data-scraper
npm install
```

## Configure

Copy the example env file and fill in your Booru credentials:

```bash
cp .env-example .env
```

Edit `.env`:

```
API_USERNAME=
API_TOKEN=
```

## Run

```bash
npm start
```

This fetches every page of image posts and writes the combined results to `booru_data.json` in this directory.

## Notes

- `booru_data.json` is only written if **every** page fetches successfully. If any request fails partway through, the script aborts and leaves any existing `booru_data.json` untouched, since a partial scrape isn't a usable result.
- `booru_data.json` is regenerated fresh each run and is gitignored — it's not meant to be committed.
