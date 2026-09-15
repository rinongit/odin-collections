# Odin Streaming Collections

A tiny Stremio-compatible catalog addon designed for Viren070's AIOStreams Jellyfin adapter.

It exposes streaming services as movie collection entries so the Jellyfin adapter can render them as **BoxSets** in clients such as Odin.

## Providers

- Netflix
- Prime Video
- Disney+
- Max / HBO
- Apple TV+
- Paramount+
- Peacock
- Hulu

Movie membership is refreshed automatically from JustWatch using the same provider codes used by the open-source Streaming Catalogs addon.

## AIOStreams manifest

After GitHub Pages is deployed, add this as a Custom Addon in AIOStreams:

`https://rinongit.github.io/odin-collections/manifest.json`

## How it works

The addon exposes one catalog called `Streaming Collections`. Its entries are movie-type collection roots (`odincol.netflix`, etc.). Each collection's meta contains a `videos[]` array of IMDb movie IDs. Viren070's Jellyfin adapter recognizes catalogs whose name/type/id contains `collection` and exposes these entries as Jellyfin BoxSets.

## Updating

GitHub Actions refreshes provider membership every 6 hours. The default region is `US` and the generated provider files keep their previous data if JustWatch has a temporary failure.
