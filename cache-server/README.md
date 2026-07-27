# Cache Server

Edge-cache proxy that sits between a VRChat world and the Booru server, caching images and metadata on disk.

## Requirements

- Node.js 18+
- npm

## Install

```bash
cd cache-server
npm install
```

## Configure

Copy the example env file and fill in your Booru credentials:

```bash
cp .env-example .env
```

Edit `.env`:

```
BOORU_USERNAME=
BOORU_API_TOKEN=
PORT=3000
```

`BOORU_USERNAME`/`BOORU_API_TOKEN` can be left blank to send unauthenticated requests. `PORT` defaults to `3000` if unset.

## Run

For local testing:

```bash
npm start
```

Check it's up:

```bash
curl http://localhost:3000/health
```

## Run with PM2

Install PM2 globally if you don't already have it:

```bash
npm install -g pm2
```

Start the server:

```bash
pm2 start server.js --name cache-server
```

Useful commands:

```bash
pm2 status              # check it's running
pm2 logs cache-server   # tail logs
pm2 restart cache-server
pm2 stop cache-server
```

To have PM2 restart the server automatically on server reboot:

```bash
pm2 save
pm2 startup
```

(`pm2 startup` prints a command you need to run once, with sudo, to install the boot script.)

## Notes

- The server also writes its own request log to `server.log` in this directory.
- Cached files are stored in `image_cache/`, `info_cache/`, and `stats_cache/` — safe to delete if you need to clear the cache.
