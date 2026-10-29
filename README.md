# Chicago Weekend (Oct 29 – Nov 2)

A private, mobile-friendly trip page for the group: Airbnb info and codes, house rules, a map, and a shared **Plan** and **Maybe** list that anyone with the link and passcode can edit. Nobody needs an account.

## How it works
- It's a static site (plain HTML, CSS and JS) hosted on GitHub Pages.
- The Airbnb details (address, codes, Wi-Fi, rules) are **encrypted** in `trip.enc.json`. The repo is public, but nobody can read them without the trip passcode.
- The shared lists are encrypted with the same passcode and stored in a free Firebase Realtime Database (or, if it's reachable, an anonymous [jsonblob.com](https://jsonblob.com) blob). The site checks for updates every 10 seconds.
- The map uses Leaflet with OpenStreetMap/CARTO tiles. Place search uses Photon (OpenStreetMap data). The forecast comes from Open-Meteo.

## First-time setup
1. Turn on GitHub Pages: **Settings → Pages → Deploy from a branch**, pick the branch and `/ (root)`.
2. Open the site, enter the passcode and your name, then tap **Set up shared list** and follow the steps: create a free Firebase project, add a Realtime Database in **test mode**, and paste its URL. The invite link is copied for you.
3. Paste the invite link in the group chat. Send the passcode separately.

## Changing the info or the passcode
Edit your private `trip.json` (it's gitignored and never committed), then run:

```
node tools/encrypt.mjs trip.json "new-passcode"
```

Then commit the new `trip.enc.json`. If you change the passcode, the shared lists need to be set up again, because the old blob was encrypted with the old passcode.
