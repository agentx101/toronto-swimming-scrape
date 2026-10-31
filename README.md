# Activity Finder for Toronto

This workspace contains the finder and its City of Toronto data pipeline.

## Run locally

```sh
node server.mjs
```

Open `http://127.0.0.1:8090/`.

The local server proxies the City of Toronto One Address Repository for Toronto address suggestions and lookups. No API key is required. OpenStreetMap Nominatim remains a fallback for addresses outside Toronto.
