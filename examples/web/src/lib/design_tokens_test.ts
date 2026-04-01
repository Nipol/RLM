import assert from 'node:assert/strict';

const stylesheet = await Deno.readTextFile(new URL('../styles.css', import.meta.url));
const [lightSection, darkSection = ''] = stylesheet.split('@media (prefers-color-scheme: dark) {');

function readToken(section: string, tokenName: string): string {
  const escapedTokenName = tokenName.replaceAll(/[$()*+.?[\\\]^{|}-]/g, '\\$&');
  const match = section.match(new RegExp(`${escapedTokenName}:\\s*([^;]+);`));

  assert.ok(match, `Expected ${tokenName} to be defined in the stylesheet.`);
  return match[1]!.trim().toLowerCase();
}

Deno.test('styles palette matches DESIGN.md light mode color tokens', () => {
  const expectedLightTokens = {
    '--canvas-gray': '#e5e5e5',
    '--snow-powder': '#fefafa',
    '--dark-chocolate': '#302f2d',
    '--ledger-gray': '#4b4642',
    '--muted-ledger': '#8a8480',
    '--faded-metadata': '#b3b2b2',
    '--quiet-border': '#cac7c6',
    '--soft-border': '#e3ddda',
    '--chocolate-pink': '#ffb6c1',
    '--milk-chocolate': '#dbd7ba',
    '--straw-chocolate': '#d2ad9b',
    '--sugar-red': '#da3434',
    '--dont-touch-green': '#39f95c',
    '--orange-yellow': '#daac37',
  } as const;

  for (const [tokenName, tokenValue] of Object.entries(expectedLightTokens)) {
    assert.equal(readToken(lightSection, tokenName), tokenValue, `${tokenName} should follow DESIGN.md.`);
  }
});

Deno.test('styles palette matches DESIGN.md dark mode color tokens', () => {
  const expectedDarkTokens = {
    '--dark-chocolate-surface': '#302f2d',
    '--warm-charcoal': '#383633',
    '--soft-charcoal': '#45423f',
    '--white-chocolate': '#e6e0d4',
    '--dust-brown': '#9a918a',
    '--dark-border': '#6e6762',
    '--soft-dark-border': '#56514d',
    '--lighted-red': '#ce5252',
    '--autumn-green': '#9dc940',
    '--maidenhair-yellow': '#daac37',
  } as const;

  for (const [tokenName, tokenValue] of Object.entries(expectedDarkTokens)) {
    assert.equal(readToken(darkSection, tokenName), tokenValue, `${tokenName} should follow DESIGN.md.`);
  }
});

Deno.test('styles choose a single active accent family per mode', () => {
  assert.equal(readToken(lightSection, '--active-accent'), 'var(--milk-chocolate)');
  assert.equal(readToken(lightSection, '--active-accent-foreground'), 'var(--dark-chocolate)');
  assert.equal(readToken(darkSection, '--active-accent'), 'var(--straw-chocolate)');
  assert.equal(readToken(darkSection, '--active-accent-foreground'), 'var(--dark-chocolate-surface)');
});

Deno.test('styles keep DESIGN.md primary colors available for selective emphasis', () => {
  assert.equal(readToken(lightSection, '--primary'), 'var(--chocolate-pink)');
  assert.equal(readToken(lightSection, '--primary-foreground'), 'var(--dark-chocolate)');
  assert.equal(readToken(lightSection, '--primary-soft'), 'rgb(255 182 193 / 0.16)');

  assert.equal(readToken(darkSection, '--primary'), 'var(--straw-chocolate)');
  assert.equal(readToken(darkSection, '--primary-foreground'), 'var(--dark-chocolate-surface)');
  assert.equal(readToken(darkSection, '--primary-soft'), 'rgb(210 173 155 / 0.16)');
});

Deno.test('styles derive reusable surfaces from the active accent and semantic palette values', () => {
  assert.equal(readToken(lightSection, '--active-accent-soft'), 'rgb(219 215 186 / 0.22)');
  assert.equal(readToken(lightSection, '--brand-surface'), 'var(--active-accent-soft)');
  assert.equal(readToken(lightSection, '--error-surface'), 'rgb(218 52 52 / 0.07)');
  assert.equal(readToken(lightSection, '--success-surface'), 'rgb(57 249 92 / 0.12)');

  assert.equal(readToken(darkSection, '--active-accent-soft'), 'rgb(210 173 155 / 0.12)');
  assert.equal(readToken(darkSection, '--brand-surface'), 'var(--active-accent-soft)');
  assert.equal(readToken(darkSection, '--error-surface'), 'rgb(206 82 82 / 0.12)');
  assert.equal(readToken(darkSection, '--success-surface'), 'rgb(157 201 64 / 0.14)');
});

Deno.test('project mark consumes the reserved primary accent instead of the active accent family', () => {
  assert.match(stylesheet, /\.project-mark\s*\{[^}]*background:\s*var\(--primary-soft\);/s);
  assert.match(stylesheet, /\.project-mark::before\s*\{[^}]*border:\s*1px solid var\(--primary\);/s);
});

Deno.test('styles spread the active accent onto a small number of calm support surfaces', () => {
  assert.match(stylesheet, /\.task-status-panel\s*\{[^}]*background:\s*var\(--brand-surface\);/s);
  assert.match(stylesheet, /\.task-status-panel\s*\{[^}]*border-color:\s*var\(--active-accent\);/s);
  assert.match(stylesheet, /\.connection-summary-panel\s*\{[^}]*background:\s*var\(--brand-surface\);/s);
  assert.match(stylesheet, /\.connection-summary-panel\s*\{[^}]*border-color:\s*var\(--active-accent\);/s);
  assert.match(stylesheet, /\.provider-choice\[data-active="true"\]\s*\{[^}]*background:\s*var\(--brand-surface\);/s);
  assert.match(stylesheet, /\.provider-choice\[data-active="true"\]\s*\{[^}]*border-color:\s*var\(--active-accent\);/s);
});
