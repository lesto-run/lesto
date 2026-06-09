// A deterministic, offline generator. It does NOT call a model — it composes a
// valid UI tree from the prompt using simple keyword heuristics. Its job is to
// (a) make the whole pipeline runnable with zero credentials, and (b) act as a
// golden reference in tests. The real AnthropicGenerator produces the same
// shape of artifact; this just fakes the "intelligence" deterministically.

export function mockGenerate(prompt) {
  const p = prompt.toLowerCase();
  const brand = titleCaseFirstNoun(prompt);

  const nav = { type: 'Navbar', props: { brand, links: [
    { label: 'Features', href: '#features' },
    { label: 'Pricing', href: '#pricing' },
    { label: 'Sign in', href: '#' },
  ] } };

  const hero = {
    type: 'Hero',
    props: {
      eyebrow: pick(p, [['ai', 'AI-NATIVE'], ['dev', 'FOR DEVELOPERS']], 'INTRODUCING'),
      title: heroTitle(prompt),
      subtitle: `Everything you need to ${verb(p)}, beautifully composed and shipped in minutes.`,
      ctaLabel: 'Get started free',
      ctaHref: '#',
    },
  };

  const children = [nav, hero];

  // Features section
  if (p.includes('feature') || p.includes('landing') || p.includes('saas') || p.includes('app') || true) {
    children.push({
      type: 'Section',
      props: { align: 'center' },
      children: [
        { type: 'Heading', props: { text: 'Why teams choose us', level: '2' } },
        {
          type: 'Grid',
          props: { columns: 3 },
          children: [
            { type: 'Feature', props: { icon: '⚡', title: 'Blazing fast', description: 'Rendered at native speed with no model in the request path.' } },
            { type: 'Feature', props: { icon: '🛡️', title: 'Safe by default', description: 'Generated UI is validated against a vetted component registry.' } },
            { type: 'Feature', props: { icon: '🎨', title: 'On-brand', description: 'Every output uses your design tokens, so nothing looks off.' } },
          ],
        },
      ],
    });
  }

  // Pricing section
  if (p.includes('pricing') || p.includes('saas') || p.includes('startup') || p.includes('landing')) {
    children.push({
      type: 'Section',
      props: { background: 'subtle', align: 'center' },
      children: [
        { type: 'Heading', props: { text: 'Simple, honest pricing', level: '2' } },
        {
          type: 'Grid',
          props: { columns: 3 },
          children: [
            { type: 'PricingTier', props: { name: 'Hobby', price: 'Free', features: ['1 project', 'Community support'], ctaLabel: 'Start' } },
            { type: 'PricingTier', props: { name: 'Pro', price: '$29/mo', features: ['Unlimited projects', 'Priority support', 'Custom domains'], featured: true, ctaLabel: 'Go Pro' } },
            { type: 'PricingTier', props: { name: 'Team', price: '$99/mo', features: ['Everything in Pro', 'SSO', 'Audit logs'], ctaLabel: 'Contact us' } },
          ],
        },
      ],
    });
  }

  children.push({ type: 'Footer', props: { text: `© ${brand}. Woven by Loom.` } });

  return { type: 'Page', props: { title: brand }, children };
}

function heroTitle(prompt) {
  const subject = titleCaseFirstNoun(prompt);
  if (/\bfor\b/i.test(prompt)) return prompt.replace(/^(a|an|the)\s+/i, '').replace(/^./, (c) => c.toUpperCase());
  return `Meet ${subject}`;
}

function titleCaseFirstNoun(prompt) {
  const stop = new Set(['a', 'an', 'the', 'landing', 'page', 'website', 'site', 'for', 'app', 'with', 'about', 'my']);
  const words = prompt.replace(/[^a-z0-9\s]/gi, ' ').split(/\s+/).filter(Boolean);
  const noun = words.find((w) => !stop.has(w.toLowerCase())) || 'Acme';
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}

function verb(p) {
  if (p.includes('shop') || p.includes('store') || p.includes('commerce')) return 'sell online';
  if (p.includes('blog') || p.includes('news')) return 'publish and grow';
  if (p.includes('dev') || p.includes('api')) return 'ship faster';
  return 'launch and scale';
}

function pick(p, pairs, fallback) {
  for (const [needle, val] of pairs) if (p.includes(needle)) return val;
  return fallback;
}
