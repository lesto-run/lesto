// The generation pipeline. Build-time only: turn a prompt into a validated UI
// tree artifact. Whichever generator runs, the output is run through the
// registry validator and repaired before it's ever saved — so a saved artifact
// is guaranteed renderable, and the request path never sees a malformed tree.

import './components/index.jsx'; // side-effect: populate the registry
import { mockGenerate } from './generators/mock.js';
import { validateTree } from './validate.js';

// generate(prompt, { generator: 'auto'|'mock'|'anthropic', model })
export async function generate(prompt, opts = {}) {
  const which = pickGenerator(opts.generator);

  let raw;
  if (which === 'anthropic') {
    const { anthropicGenerate } = await import('./generators/anthropic.js');
    raw = await anthropicGenerate(prompt, opts);
  } else {
    raw = mockGenerate(prompt);
  }

  const { valid, errors, repaired } = validateTree(raw);
  return {
    generator: which,
    tree: valid ? raw : repaired,
    valid,
    errors,
  };
}

function pickGenerator(pref = 'auto') {
  if (pref === 'mock' || pref === 'anthropic') return pref;
  // auto: use the model if a key is present, else the offline mock.
  return process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'mock';
}
