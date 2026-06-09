import React from 'react';
import { defineComponent } from '../registry.js';

// A small design-token system so generated UIs look coherent regardless of how
// the AI composes them. Inline styles keep components self-contained and
// SSR-safe (no separate CSS pipeline to hydrate).
const t = {
  color: {
    fg: '#0f172a', muted: '#64748b', bg: '#ffffff', subtle: '#f8fafc',
    border: '#e2e8f0', accent: '#4f46e5', accentFg: '#ffffff', accentSoft: '#eef2ff',
  },
  radius: { sm: 6, md: 10, lg: 16, pill: 999 },
  space: (n) => n * 4,
  font: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
};

const ALIGN = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' };

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

defineComponent('Page', {
  description: 'The root document container for a generated page. Use exactly once at the top of the tree.',
  props: {
    title: { type: 'string', description: 'Document/page title.' },
    maxWidth: { type: 'number', default: 1080, description: 'Max content width in px.' },
  },
  children: true,
  render: (p, children) => (
    <div style={{ font: t.font, color: t.color.fg, background: t.color.bg, minHeight: '100vh' }}>
      <main style={{ maxWidth: p.maxWidth, margin: '0 auto', padding: `${t.space(10)}px ${t.space(6)}px` }}>
        {children}
      </main>
    </div>
  ),
});

defineComponent('Stack', {
  description: 'Vertical (or horizontal) flex stack for arranging children with consistent spacing.',
  props: {
    direction: { type: 'enum', values: ['vertical', 'horizontal'], default: 'vertical' },
    gap: { type: 'number', default: 4, description: 'Gap between children, in 4px units.' },
    align: { type: 'enum', values: ['start', 'center', 'end', 'stretch'], default: 'stretch' },
  },
  children: true,
  render: (p, children) => (
    <div style={{
      display: 'flex',
      flexDirection: p.direction === 'horizontal' ? 'row' : 'column',
      gap: t.space(p.gap),
      alignItems: ALIGN[p.align],
      flexWrap: p.direction === 'horizontal' ? 'wrap' : 'nowrap',
    }}>{children}</div>
  ),
});

defineComponent('Grid', {
  description: 'Responsive grid layout. Good for feature lists, cards, galleries.',
  props: {
    columns: { type: 'number', default: 3, description: 'Number of columns.' },
    gap: { type: 'number', default: 6 },
  },
  children: true,
  render: (p, children) => (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(auto-fit, minmax(${Math.floor(960 / p.columns)}px, 1fr))`,
      gap: t.space(p.gap),
    }}>{children}</div>
  ),
});

defineComponent('Section', {
  description: 'A vertical content section with padding. Use to break a page into bands.',
  props: {
    background: { type: 'enum', values: ['none', 'subtle', 'accent'], default: 'none' },
    align: { type: 'enum', values: ['start', 'center'], default: 'start' },
  },
  children: true,
  render: (p, children) => (
    <section style={{
      padding: `${t.space(12)}px ${t.space(6)}px`,
      background: p.background === 'subtle' ? t.color.subtle : p.background === 'accent' ? t.color.accentSoft : 'transparent',
      borderRadius: t.radius.lg,
      textAlign: p.align,
      display: 'flex', flexDirection: 'column',
      alignItems: p.align === 'center' ? 'center' : 'flex-start',
      gap: t.space(4),
    }}>{children}</section>
  ),
});

defineComponent('Card', {
  description: 'A bordered card surface for grouping related content.',
  props: { padding: { type: 'number', default: 6 } },
  children: true,
  render: (p, children) => (
    <div style={{
      border: `1px solid ${t.color.border}`, borderRadius: t.radius.md,
      padding: t.space(p.padding), background: t.color.bg,
      display: 'flex', flexDirection: 'column', gap: t.space(3),
    }}>{children}</div>
  ),
});

// ---------------------------------------------------------------------------
// Content primitives
// ---------------------------------------------------------------------------

defineComponent('Heading', {
  description: 'A heading. Level 1 is the largest (page title), 6 the smallest.',
  props: {
    text: { type: 'string', required: true },
    level: { type: 'enum', values: ['1', '2', '3', '4'], default: '2' },
  },
  children: false,
  render: (p) => {
    const sizes = { '1': 44, '2': 32, '3': 24, '4': 19 };
    const Tag = `h${p.level}`;
    return <Tag style={{ fontSize: sizes[p.level], lineHeight: 1.15, margin: 0, fontWeight: 700, letterSpacing: '-0.02em' }}>{p.text}</Tag>;
  },
});

defineComponent('Text', {
  description: 'A paragraph of body text.',
  props: {
    text: { type: 'string', required: true },
    tone: { type: 'enum', values: ['default', 'muted'], default: 'default' },
    size: { type: 'enum', values: ['sm', 'md', 'lg'], default: 'md' },
  },
  children: false,
  render: (p) => {
    const sizes = { sm: 14, md: 16, lg: 19 };
    return <p style={{ margin: 0, fontSize: sizes[p.size], lineHeight: 1.6, color: p.tone === 'muted' ? t.color.muted : t.color.fg }}>{p.text}</p>;
  },
});

defineComponent('Button', {
  description: 'A call-to-action button or link.',
  props: {
    label: { type: 'string', required: true },
    href: { type: 'string', description: 'If set, renders as a link.' },
    variant: { type: 'enum', values: ['primary', 'secondary', 'ghost'], default: 'primary' },
  },
  children: false,
  render: (p) => {
    const base = {
      display: 'inline-block', padding: `${t.space(2.5)}px ${t.space(5)}px`,
      borderRadius: t.radius.pill, fontSize: 15, fontWeight: 600, textDecoration: 'none',
      cursor: 'pointer', border: '1px solid transparent', transition: 'opacity .15s',
    };
    const variants = {
      primary: { background: t.color.accent, color: t.color.accentFg },
      secondary: { background: t.color.subtle, color: t.color.fg, borderColor: t.color.border },
      ghost: { background: 'transparent', color: t.color.accent },
    };
    const style = { ...base, ...variants[p.variant] };
    return p.href
      ? <a href={p.href} style={style}>{p.label}</a>
      : <button type="button" style={style}>{p.label}</button>;
  },
});

defineComponent('Image', {
  description: 'A responsive image with rounded corners.',
  props: {
    src: { type: 'string', required: true },
    alt: { type: 'string', default: '' },
    rounded: { type: 'boolean', default: true },
  },
  children: false,
  render: (p) => (
    <img src={p.src} alt={p.alt} style={{ maxWidth: '100%', height: 'auto', borderRadius: p.rounded ? t.radius.lg : 0, display: 'block' }} />
  ),
});

defineComponent('Badge', {
  description: 'A small pill label, e.g. for "New" or a category.',
  props: { text: { type: 'string', required: true } },
  children: false,
  render: (p) => (
    <span style={{ display: 'inline-block', background: t.color.accentSoft, color: t.color.accent, padding: '4px 12px', borderRadius: t.radius.pill, fontSize: 13, fontWeight: 600 }}>{p.text}</span>
  ),
});

// ---------------------------------------------------------------------------
// Composite / marketing components (where the AI gets real leverage)
// ---------------------------------------------------------------------------

defineComponent('Hero', {
  description: 'A prominent hero banner with a headline, subtext, and a primary call-to-action.',
  props: {
    title: { type: 'string', required: true },
    subtitle: { type: 'string' },
    ctaLabel: { type: 'string' },
    ctaHref: { type: 'string', default: '#' },
    eyebrow: { type: 'string', description: 'Small label above the title.' },
  },
  children: false,
  render: (p) => (
    <section style={{ textAlign: 'center', padding: `${t.space(16)}px ${t.space(4)}px`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: t.space(5) }}>
      {p.eyebrow ? <span style={{ color: t.color.accent, fontWeight: 600, fontSize: 14, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{p.eyebrow}</span> : null}
      <h1 style={{ fontSize: 56, lineHeight: 1.05, margin: 0, fontWeight: 800, letterSpacing: '-0.03em', maxWidth: 760 }}>{p.title}</h1>
      {p.subtitle ? <p style={{ fontSize: 20, color: t.color.muted, margin: 0, maxWidth: 560, lineHeight: 1.5 }}>{p.subtitle}</p> : null}
      {p.ctaLabel ? <a href={p.ctaHref} style={{ marginTop: t.space(2), background: t.color.accent, color: t.color.accentFg, padding: `${t.space(3.5)}px ${t.space(8)}px`, borderRadius: t.radius.pill, fontWeight: 600, textDecoration: 'none', fontSize: 17 }}>{p.ctaLabel}</a> : null}
    </section>
  ),
});

defineComponent('Feature', {
  description: 'A single feature: an icon/emoji, a title, and a short description.',
  props: {
    icon: { type: 'string', default: '✦', description: 'An emoji or short symbol.' },
    title: { type: 'string', required: true },
    description: { type: 'string' },
  },
  children: false,
  render: (p) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: t.space(2) }}>
      <div style={{ fontSize: 28 }}>{p.icon}</div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{p.title}</div>
      {p.description ? <div style={{ color: t.color.muted, lineHeight: 1.5 }}>{p.description}</div> : null}
    </div>
  ),
});

defineComponent('PricingTier', {
  description: 'A single pricing plan card with a name, price, feature list, and CTA.',
  props: {
    name: { type: 'string', required: true },
    price: { type: 'string', required: true, description: 'e.g. "$29/mo" or "Free".' },
    features: { type: 'array', description: 'Array of feature strings.', default: [] },
    ctaLabel: { type: 'string', default: 'Get started' },
    ctaHref: { type: 'string', default: '#' },
    featured: { type: 'boolean', default: false, description: 'Visually highlight this tier.' },
  },
  children: false,
  render: (p) => (
    <div style={{
      border: `${p.featured ? 2 : 1}px solid ${p.featured ? t.color.accent : t.color.border}`,
      borderRadius: t.radius.lg, padding: t.space(7), display: 'flex', flexDirection: 'column', gap: t.space(4),
      background: p.featured ? t.color.accentSoft : t.color.bg,
    }}>
      <div style={{ fontWeight: 700, fontSize: 18 }}>{p.name}</div>
      <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.02em' }}>{p.price}</div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: t.space(2) }}>
        {(p.features || []).map((f, i) => (
          <li key={i} style={{ color: t.color.muted }}>✓ {String(f)}</li>
        ))}
      </ul>
      <a href={p.ctaHref} style={{ marginTop: 'auto', textAlign: 'center', background: p.featured ? t.color.accent : t.color.subtle, color: p.featured ? t.color.accentFg : t.color.fg, padding: `${t.space(2.5)}px 0`, borderRadius: t.radius.pill, fontWeight: 600, textDecoration: 'none', border: `1px solid ${p.featured ? 'transparent' : t.color.border}` }}>{p.ctaLabel}</a>
    </div>
  ),
});

defineComponent('Navbar', {
  description: 'A top navigation bar with a brand name and links.',
  props: {
    brand: { type: 'string', required: true },
    links: { type: 'array', default: [], description: 'Array of { label, href } objects.' },
  },
  children: false,
  render: (p) => (
    <nav style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: `${t.space(4)}px 0`, borderBottom: `1px solid ${t.color.border}` }}>
      <span style={{ fontWeight: 800, fontSize: 18 }}>{p.brand}</span>
      <div style={{ display: 'flex', gap: t.space(6) }}>
        {(p.links || []).map((l, i) => (
          <a key={i} href={l?.href || '#'} style={{ color: t.color.muted, textDecoration: 'none', fontSize: 15 }}>{l?.label || ''}</a>
        ))}
      </div>
    </nav>
  ),
});

defineComponent('Footer', {
  description: 'A page footer with a small copyright/credit line.',
  props: { text: { type: 'string', required: true } },
  children: false,
  render: (p) => (
    <footer style={{ borderTop: `1px solid ${t.color.border}`, marginTop: t.space(12), paddingTop: t.space(6), color: t.color.muted, fontSize: 14, textAlign: 'center' }}>{p.text}</footer>
  ),
});

// Importing this module registers every component as a side effect.
export const COMPONENT_COUNT = 14;
