# Aylachi

Aylachi is an experimental native desktop workspace for AI-assisted coding sessions. It combines a canvas of chat nodes with a persistent runtime and a Pi-compatible agent host.

> **Status: alpha.** Expect incomplete features and incompatible changes.

## About this repository

This repository contains reviewed public source snapshots. Day-to-day development history and private runtime data are not published here.

## Requirements

- Node.js `>=22.19.0 <23`
- Rust and the platform dependencies required by Tauri for native desktop builds

## Development

```sh
npm run bootstrap
npm test
```

The test runner uses isolated development state. Do not run it against a real workspace or session directory.
