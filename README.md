# NahuenTV

Control the TVs in all your stores from one web page: slideshows, videos, and live TV switching.

- **Control panel** (`/admin`): stores, TVs, media library, playlists, assigning content per TV / store / all stores, live TV mode and schedules, store screen hours, online status.
- **TV player** (`/tv/<secret>`): runs full screen in Fully Kiosk Browser on a Fire TV Stick. It saves media on the device so it keeps playing when the internet drops (needs https).

**Setup instructions: see [SETUP.md](SETUP.md).**

## Run it on your own computer (to try it out)

Requires Node.js 22.13 or newer.

```
npm install
npm start
```

Open http://localhost:3000. Data is saved in `./data`.

## Files

| File | What it is |
|---|---|
| `server.js` | The server (API, database, file uploads) |
| `public/admin.*` | Control panel |
| `public/player.*`, `public/sw.js` | TV player and offline cache |
| `install.sh` | One-command installer for an Ubuntu server |
| `reset-password.js` | Reset the control panel password from the server |
