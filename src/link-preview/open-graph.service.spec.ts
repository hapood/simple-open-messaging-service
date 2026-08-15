import { describe, it, expect } from 'vitest';
import { OpenGraphService } from './open-graph.service.js';

describe('OpenGraphService.parse', () => {
  const og = new OpenGraphService();
  const base = 'https://example.com/page';

  it('extracts title, description, image and site name', () => {
    const html = `<head>
      <meta property="og:title" content="Hello">
      <meta property="og:description" content="World">
      <meta property="og:site_name" content="Example">
      <meta property="og:image" content="https://example.com/img.jpg">
    </head>`;
    expect(og.parse(html, base)).toEqual({
      title: 'Hello',
      description: 'World',
      image: 'https://example.com/img.jpg',
      favicon: 'https://example.com/favicon.ico',
      siteName: 'Example',
    });
  });

  it('falls back to twitter:* then the <title> tag', () => {
    expect(
      og.parse(
        `<meta name="twitter:title" content="Tw"><title>Tag</title>`,
        base,
      ).title,
    ).toBe('Tw');
    expect(og.parse(`<title>The Tag</title>`, base).title).toBe('The Tag');
  });

  it('uses document title then the registrable domain as the site name fallback', () => {
    expect(
      og.parse('<title>Document source</title>', 'https://www.example.com/x')
        .siteName,
    ).toBe('Document source');
    expect(
      og.parse('<html></html>', 'https://news.example.co.uk/x').siteName,
    ).toBe('example.co.uk');
  });

  it('resolves a relative og:image against the base URL', () => {
    const html = `<meta property="og:image" content="/static/cover.jpg">`;
    expect(og.parse(html, base).image).toBe(
      'https://example.com/static/cover.jpg',
    );
  });

  it('selects the first or last repeated og:image according to the rule', () => {
    const html = `
      <meta property="og:image" content="/platform.png">
      <meta property="og:image:width" content="1200">
      <meta property="og:image" content="/note.jpg">
    `;
    expect(og.parse(html, base).image).toBe('https://example.com/platform.png');
    expect(og.parse(html, base, 'last').image).toBe(
      'https://example.com/note.jpg',
    );
  });

  it('selects repeated descriptions independently and extracts site_name', () => {
    const html = `
      <meta name="og:description" content="Generic">
      <meta property="og:site_name" content="Xiaohongshu">
      <meta property="og:description" content="The note body">
    `;
    expect(og.parse(html, base)).toMatchObject({
      description: 'Generic',
      siteName: 'Xiaohongshu',
    });
    expect(og.parse(html, base, 'first', 'last').description).toBe(
      'The note body',
    );
  });

  it('caps over-long fields to the stored limit', () => {
    const html = `<meta property="og:title" content="${'x'.repeat(400)}">`;
    expect(og.parse(html, base).title?.length).toBe(300);
  });

  it('falls back to the conventional origin favicon', () => {
    expect(og.parse('<html></html>', base)).toEqual({
      title: undefined,
      description: undefined,
      image: undefined,
      favicon: 'https://example.com/favicon.ico',
      siteName: 'example.com',
    });
  });

  it('extracts and resolves an explicit favicon', () => {
    const html = `<link rel="shortcut icon" href="/assets/icon.png">`;
    expect(og.parse(html, base).favicon).toBe(
      'https://example.com/assets/icon.png',
    );
  });

  it('decodes HTML entities in values', () => {
    const html = `<meta property="og:title" content="A &amp; B &#39;C&#39; &#x78;">`;
    expect(og.parse(html, base).title).toBe("A & B 'C' x");
  });

  it('handles single-quoted and unquoted attribute values', () => {
    const html = `<meta property='og:title' content='SQ'><meta name=og:description content=UQ>`;
    expect(og.parse(html, base).title).toBe('SQ');
  });
});
