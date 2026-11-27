import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { APP_VERSION } from '../server/version.mjs';
import { otlpPayload } from '../server/otlp.mjs';

const manifest = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));

test('package version is SemVer and matches the shared runtime version', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(APP_VERSION, manifest.version);
});

test('changelog starts with the manifest version', () => {
  const changelog = fs.readFileSync(path.resolve('CHANGELOG.md'), 'utf8');
  const firstVersion = changelog.match(/^## \[([^\]]+)\]/m)?.[1];
  assert.equal(firstVersion, manifest.version);
});

test('OTLP resource and scope use the manifest version', () => {
  const payload = otlpPayload([]);
  const resource = payload.resourceSpans[0].resource.attributes;
  const serviceVersion = resource.find((item) => item.key === 'service.version');
  assert.equal(serviceVersion.value.stringValue, manifest.version);
  assert.equal(payload.resourceSpans[0].scopeSpans[0].scope.version, manifest.version);
});

test('MCP client version comes from the shared version module', () => {
  const source = fs.readFileSync(path.resolve('server/mcp.mjs'), 'utf8');
  assert.match(source, /import \{ APP_VERSION \} from '\.\/version\.mjs';/);
  assert.match(source, /clientInfo: \{ name: 'AgentForge', version: APP_VERSION \}/);
  assert.doesNotMatch(source, /clientInfo: \{[^\n]*version: '\d+\.\d+\.\d+'/);
});
