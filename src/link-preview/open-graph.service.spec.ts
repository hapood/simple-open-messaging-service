import { describe, it, expect } from 'vitest';
import { OpenGraphService } from './open-graph.service.js';

describe('OpenGraphService.parse', () => {
  const og = new OpenGraphService();
  const base = 'https://example.com/page';

  it('extracts og:title / og:description / og:site_name / og:image', () => {
    const html = `<head>
      <meta property="og:title" content="Hello">
      <meta property="og:description" content="World">
      <meta property="og:site_name" content="Example">
      <meta property="og:image" content="https://example.com/img.jpg">
    </head>`;
    expect(og.parse(html, base)).toEqual({
      title: 'Hello',
      description: 'World',
      siteName: 'Example',
      image: 'https://example.com/img.jpg',
    });
  });

  it('falls back to twitter:* then the <title> tag', () => {
    expect(og.parse(`<meta name="twitter:title" content="Tw"><title>Tag</title>`, base).title).toBe('Tw');
    expect(og.parse(`<title>The Tag</title>`, base).title).toBe('The Tag');
  });

  it('resolves a relative og:image against the base URL', () => {
    const html = `<meta property="og:image" content="/static/cover.jpg">`;
    expect(og.parse(html, base).image).toBe('https://example.com/static/cover.jpg');
  });

  it('caps over-long fields to the stored limit', () => {
    const html = `<meta property="og:title" content="${'x'.repeat(400)}">`;
    expect(og.parse(html, base).title?.length).toBe(300);
  });

  it('returns no fields when the page provides none', () => {
    expect(og.parse('<html></html>', base)).toEqual({});
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
