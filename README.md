# GreenLight Motion Engine — source

The video engine for AI agents: motion-design videos with 3D camera and rigs, particles, shader effects and
transitions, motion blur and speed curves, previewed and rendered to MP4 in the browser — a double-clicked page or
a Claude artifact, no install. It is the compositor of the [GreenLight Dash](https://greenlightdash.pro/) Video
Editor; a project made with it opens there for full editing.

- **Use it:** the npm package [`greenlight-motion`](motion-engine/README.md) — `npx greenlight-motion doctor`, or in a
  page from jsDelivr: `https://cdn.jsdelivr.net/npm/greenlight-motion@0.1.0/dist/greenlight-motion.js`.
- **This repository** is the source, published from GreenLight Dash on each release:
  - `frontend/src/` — every file the engine bundle is built from (the editor's compositor, effects, transitions,
    3D, particles, text, the page);
  - `motion-engine/` — the npm package: CLI, agent skill, schema, examples, docs.

## Build from source

```sh
cd frontend && npm install && npm run build      # → motion-engine/dist/greenlight-motion.js + .mjs
cd ../motion-engine && npm install && node cli/index.mjs doctor
```

Needs Node 18+; the engine draws with WebGPU (Chrome or Edge).

## Licence

[Apache License 2.0](LICENSE) — see [NOTICE](NOTICE) and [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md). Library
sounds and 3D files on the GreenLight CDN have their own terms ([motion-engine/legal/](motion-engine/legal/README.md)).
GreenLight, GreenLight Dash, GLEA and GreenLight Motion are trademarks of WPSOUL
([policy](motion-engine/legal/TRADEMARKS.md)). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).
