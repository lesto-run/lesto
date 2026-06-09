import { describe, it, expect, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Importing the barrel registers the component library and exposes the engine.
import {
  allComponents,
  hasComponent,
  treeJsonSchema,
  componentCatalog,
  renderTree,
  validateTree,
  generate,
} from '../src/index.js';

describe('registry', () => {
  it('registers the component library', () => {
    expect(allComponents().length).toBeGreaterThanOrEqual(14);
    expect(hasComponent('Page')).toBe(true);
    expect(hasComponent('Hero')).toBe(true);
    expect(hasComponent('Nope')).toBe(false);
  });
});

describe('manifest / JSON Schema', () => {
  it('builds a recursive tree schema covering every component', () => {
    const schema = treeJsonSchema();
    const variants = schema.$defs.node.oneOf;
    // one variant per component + a string leaf
    expect(variants.length).toBe(allComponents().length + 1);
    expect(variants).toContainEqual({ type: 'string' });
    // children recurse back to the node definition
    expect(schema.$defs.Page.properties.children.items.$ref).toBe('#/$defs/node');
  });

  it('marks required props in the schema', () => {
    const schema = treeJsonSchema();
    expect(schema.$defs.Button.properties.props.required).toContain('label');
    expect(schema.$defs.Hero.properties.props.required).toContain('title');
  });

  it('emits a model-friendly catalog', () => {
    const cat = componentCatalog();
    const button = cat.find((c) => c.type === 'Button');
    expect(button.props.label.required).toBe(true);
    expect(button.props.variant.type).toMatch(/^enum/);
  });
});

describe('renderer', () => {
  it('renders a valid tree to HTML', () => {
    const tree = {
      type: 'Page',
      children: [
        { type: 'Hero', props: { title: 'Hello', ctaLabel: 'Go', ctaHref: '#' } },
        { type: 'Heading', props: { text: 'Features', level: '2' } },
      ],
    };
    const { element, errors } = renderTree(tree);
    const html = renderToStaticMarkup(element);
    expect(errors).toHaveLength(0);
    expect(html).toContain('Hello');
    expect(html).toContain('Features');
  });

  it('escapes untrusted text (no live XSS)', () => {
    const tree = { type: 'Page', children: [{ type: 'Heading', props: { text: '<img src=x onerror=alert(1)>', level: '2' } }] };
    const html = renderToStaticMarkup(renderTree(tree).element);
    expect(/<img[^>]*onerror=/i.test(html)).toBe(false);
    expect(html).toContain('&lt;img');
  });

  it('drops unknown components without throwing', () => {
    const tree = { type: 'Page', children: [{ type: 'TotallyFake', props: {} }] };
    const { errors } = renderTree(tree);
    let html;
    expect(() => { html = renderToStaticMarkup(renderTree(tree).element); }).not.toThrow();
    expect(errors.some((e) => e.type === 'unknown-component')).toBe(true);
  });

  it('contains a render error to its own node (sibling still renders)', () => {
    const tree = {
      type: 'Page',
      children: [
        { type: 'Heading', props: {} }, // missing required `text`
        { type: 'Heading', props: { text: 'I survive', level: '2' } },
      ],
    };
    const html = renderToStaticMarkup(renderTree(tree).element);
    expect(html).toContain('I survive');
  });
});

describe('validateTree (build-time repair)', () => {
  it('accepts a valid tree', () => {
    const tree = { type: 'Page', children: [{ type: 'Heading', props: { text: 'Hi', level: '1' } }] };
    expect(validateTree(tree).valid).toBe(true);
  });

  it('flags + repairs an invalid tree', () => {
    const tree = {
      type: 'Page',
      children: [
        { type: 'Hero', props: {} },                    // missing required title -> dropped
        { type: 'EvilScript', props: { src: 'x' } },    // unknown -> dropped
        { type: 'Button', props: { label: 'ok', variant: 'bogus' } }, // bad enum -> kept, variant stripped
      ],
    };
    const { valid, errors, repaired } = validateTree(tree);
    expect(valid).toBe(false);
    expect(errors.map((e) => e.type)).toEqual(
      expect.arrayContaining(['invalid-prop', 'unknown-component'])
    );
    const kinds = repaired.children.map((c) => c.type);
    expect(kinds).toContain('Button');
    expect(kinds).not.toContain('Hero');
    expect(kinds).not.toContain('EvilScript');
    // bad enum value was stripped; Button falls back to its default
    expect(repaired.children.find((c) => c.type === 'Button').props?.variant).toBeUndefined();
  });

  it('coerces prop types', () => {
    const tree = { type: 'Page', props: { maxWidth: '900' }, children: [] };
    expect(validateTree(tree).repaired.props.maxWidth).toBe(900); // string -> number
  });
});

describe('generation pipeline (offline mock)', () => {
  it('produces a renderable, valid tree from a prompt', async () => {
    const { tree, valid, generator } = await generate('a SaaS landing page with pricing', { generator: 'mock' });
    expect(generator).toBe('mock');
    expect(valid).toBe(true);
    expect(tree.type).toBe('Page');
    // the mock composes a pricing section for this prompt
    const html = renderToStaticMarkup(renderTree(tree).element);
    expect(html).toMatch(/pricing/i);
    expect(html).toContain('Pro');
  });

  it('every generated node is a registered component', async () => {
    const { tree } = await generate('a landing page for a coffee shop', { generator: 'mock' });
    const walk = (n) => {
      if (typeof n === 'string') return true;
      if (!hasComponent(n.type)) return false;
      return (n.children || []).every(walk);
    };
    expect(walk(tree)).toBe(true);
  });
});
