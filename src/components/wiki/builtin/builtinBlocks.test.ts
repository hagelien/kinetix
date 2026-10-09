import { describe, expect, it } from 'vitest';
import { expandBuiltinBlockMarkers } from './builtinBlocks';

describe('expandBuiltinBlockMarkers', () => {
  it('turns a marker paragraph into a mount point', () => {
    expect(
      expandBuiltinBlockMarkers('<h2>Intro</h2><p>{{kinetix:agents}}</p>'),
    ).toBe(
      '<h2>Intro</h2><div class="kx-builtin-block not-prose" data-kx-block="agents"></div>',
    );
  });

  it('accepts a fact-wrapped paragraph and inner whitespace', () => {
    expect(
      expandBuiltinBlockMarkers(
        '<p class="monograph-fact" data-fact-id="f1"> {{ kinetix:agents }} </p>',
      ),
    ).toBe(
      '<div class="kx-builtin-block not-prose" data-kx-block="agents"></div>',
    );
  });

  it('leaves unknown names and inline mentions as text', () => {
    const unknown = '<p>{{kinetix:nope}}</p>';
    expect(expandBuiltinBlockMarkers(unknown)).toBe(unknown);
    const inline = '<p>Write {{kinetix:agents}} on its own line.</p>';
    expect(expandBuiltinBlockMarkers(inline)).toBe(inline);
  });
});
