import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./main.jsx', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const styles = readFileSync(new URL('./g5.css', import.meta.url), 'utf8');

test('Agentation is local and restricted to the development UI bundle', () => {
  assert.match(source, /import\.meta\.env\.MODE === "development"/);
  assert.match(source, /import \{ Agentation as DevelopmentAgentation \} from "agentation"/);
  assert.match(source, /<Agentation appName="Aylachi DEV" \/>/);
  assert.doesNotMatch(source, /agentation-mcp|endpoint=|webhookUrl=/);
  assert.equal(manifest.devDependencies.agentation, '3.1.2');
  assert.equal(manifest.scripts['build:dev'], 'vite build --mode development');
  assert.match(styles, /\.activity-center \{[^}]*left: 16px; bottom: 64px;/);
  assert.match(styles, /\.activity-center > summary/);
});
