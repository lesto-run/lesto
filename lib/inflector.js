'use strict';

// A deliberately small inflector — enough to power Tracks' naming conventions
// (Post -> posts -> PostsController -> /posts). Not linguistically complete,
// but it handles the common English cases Rails users expect.

const PLURAL = [
  [/(quiz)$/i, '$1zes'],
  [/([m|l])ouse$/i, '$1ice'],
  [/(matr|vert|ind)(ix|ex)$/i, '$1ices'],
  [/(x|ch|ss|sh)$/i, '$1es'],
  [/([^aeiouy]|qu)y$/i, '$1ies'],
  [/(hive)$/i, '$1s'],
  [/(?:([^f])fe|([lr])f)$/i, '$1$2ves'],
  [/sis$/i, 'ses'],
  [/([ti])um$/i, '$1a'],
  [/(buffal|tomat|potat)o$/i, '$1oes'],
  [/(bu)s$/i, '$1ses'],
  [/(alias|status)$/i, '$1es'],
  [/(ax|test)is$/i, '$1es'],
  [/s$/i, 's'],
  [/$/, 's'],
];

const SINGULAR = [
  [/(quiz)zes$/i, '$1'],
  [/(matr)ices$/i, '$1ix'],
  [/(vert|ind)ices$/i, '$1ex'],
  [/(alias|status)(es)?$/i, '$1'],
  [/([octop|vir])i$/i, '$1us'],
  [/(cris|ax|test)es$/i, '$1is'],
  [/(shoe)s$/i, '$1'],
  [/(o)es$/i, '$1'],
  [/(bus)(es)?$/i, '$1'],
  [/([m|l])ice$/i, '$1ouse'],
  [/(x|ch|ss|sh)es$/i, '$1'],
  [/(m)ovies$/i, '$1ovie'],
  [/([^aeiouy]|qu)ies$/i, '$1y'],
  [/([lr])ves$/i, '$1f'],
  [/(hive)s$/i, '$1'],
  [/(tive)s$/i, '$1'],
  [/([^f])ves$/i, '$1fe'],
  [/(t)he(sis|ses)$/i, '$1hesis'],
  [/([ti])a$/i, '$1um'],
  [/(n)ews$/i, '$1ews'],
  [/s$/i, ''],
];

const IRREGULAR = [
  ['person', 'people'],
  ['man', 'men'],
  ['child', 'children'],
  ['foot', 'feet'],
  ['tooth', 'teeth'],
  ['goose', 'geese'],
];

const UNCOUNTABLE = new Set(['equipment', 'information', 'rice', 'money', 'species', 'series', 'fish', 'sheep']);

function pluralize(word) {
  if (UNCOUNTABLE.has(word.toLowerCase())) return word;
  for (const [s, p] of IRREGULAR) if (word.toLowerCase() === s) return p;
  for (const [re, rep] of PLURAL) if (re.test(word)) return word.replace(re, rep);
  return word;
}

function singularize(word) {
  if (UNCOUNTABLE.has(word.toLowerCase())) return word;
  for (const [s, p] of IRREGULAR) if (word.toLowerCase() === p) return s;
  for (const [re, rep] of SINGULAR) if (re.test(word)) return word.replace(re, rep);
  return word;
}

// "blog_post" / "blog-post" -> "BlogPost"
function camelize(str) {
  return str
    .replace(/[_-]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)/, (c) => c.toUpperCase());
}

// "BlogPost" -> "blog_post"
function underscore(str) {
  return str
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

// "BlogPost" / "blog_post" -> "blog-post"
function dasherize(str) {
  return underscore(str).replace(/_/g, '-');
}

// Class name -> table name. "BlogPost" -> "blog_posts"
function tableize(str) {
  return pluralize(underscore(str));
}

// table name -> class name. "blog_posts" -> "BlogPost"
function classify(str) {
  return camelize(singularize(str));
}

// "title" -> "Title", "created_at" -> "Created at"
function humanize(str) {
  const s = underscore(str).replace(/_id$/, '').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = {
  pluralize,
  singularize,
  camelize,
  underscore,
  dasherize,
  tableize,
  classify,
  humanize,
};
