// Mephisto UI translation. Plain script, no module: the options page loads it with a <script> tag,
// the service worker with importScripts(), and the panel gets it injected as a content script -- so
// all three share ONE language list and one lookup, and none of them can drift from the others.
//
// NOT chrome.i18n. Chrome's own i18n picks the BROWSER's UI locale and offers no way to override it
// at runtime, and the whole point here is a Language setting you choose yourself. `_locales/` stays
// for what it is actually for (the extension name in the Chrome UI).
//
// One JSON per language in locales/, flat key -> text. English is the fallback for every key, so a
// locale that is missing a string shows English rather than a blank or a raw key, and adding a string
// to the UI never breaks a translation that has not caught up yet.
(function (root) {
'use strict';

// code == the locales/<code>.json filename. `name` is each language IN THAT LANGUAGE -- someone
// looking for their own language is not helped by a list written in English.
const LANGUAGES = [
    {code: 'en', name: 'English'},
    {code: 'de', name: 'Deutsch'},
    {code: 'es', name: 'Español'},
    {code: 'fr', name: 'Français'},
    {code: 'pt', name: 'Português'},
    {code: 'it', name: 'Italiano'},
    {code: 'nl', name: 'Nederlands'},
    {code: 'pl', name: 'Polski'},
    {code: 'tr', name: 'Türkçe'},
    {code: 'ru', name: 'Русский'},
    {code: 'zh', name: '中文'},
    {code: 'hi', name: 'हिन्दी'},
    {code: 'ja', name: '日本語'},
    {code: 'ko', name: '한국어'},
];
const DEFAULT_LANG = 'en';
const LANG_CODES = LANGUAGES.map(l => l.code);

let strings = {};          // the active locale
let fallback = {};         // English, always
let current = DEFAULT_LANG;

// {name} placeholders, so a translator can move the value to wherever the sentence needs it rather
// than being stuck with English word order -- which is the usual reason string concatenation makes
// translations read badly.
function format(text, vars) {
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// The English text is passed in at every call site as `dflt`, so the source stays readable and a key
// that is missing everywhere still renders something sensible.
function t(key, dflt, vars) {
    const text = strings[key] ?? fallback[key] ?? dflt ?? key;
    return format(text, vars);
}

function setStrings(lang, obj) {
    current = LANG_CODES.includes(lang) ? lang : DEFAULT_LANG;
    strings = obj || {};
    if (current === DEFAULT_LANG) fallback = strings;
}

function setFallback(obj) { fallback = obj || {}; }

// Extension-origin contexts only (options page, service worker). The panel runs in the page's
// isolated world, where a fetch of a chrome-extension:// URL is blocked unless the file is listed in
// web_accessible_resources -- and that list was deliberately emptied, because an extension URL the
// page can reach is an extension the page can detect. The panel asks the worker instead.
async function fetchLocale(lang) {
    if (!LANG_CODES.includes(lang)) return null; // also the path-traversal guard: `lang` is a setting
    const url = (root.chrome?.runtime?.getURL)
        ? chrome.runtime.getURL(`src/i18n/locales/${lang}.json`)
        : `locales/${lang}.json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json();
}

// Load `lang` plus English underneath it, and make both active.
async function use(lang) {
    const en = (lang === DEFAULT_LANG) ? null : await fetchLocale(DEFAULT_LANG).catch(() => null);
    const obj = await fetchLocale(lang).catch(() => null);
    setFallback(en || obj || {});
    setStrings(lang, obj || en || {});
    return strings;
}

// --- applying a locale to markup ----------------------------------------------------------------
//   data-i18n        -> the element's text
//   data-i18n-tip    -> its data-tooltip (Materialize reads that attribute)
//   data-i18n-title  -> its title attribute
//
// The text case replaces the element's FIRST TEXT NODE, not its textContent. Several labels here are
// `<label>Some Setting <i class="material-icons">info</i></label>` -- an icon element, or a <span>
// holding a live value, sitting inside the same label. Assigning textContent would delete it.
function apply(scope) {
    const el = scope || root.document;
    if (!el || !el.querySelectorAll) return;
    for (const node of el.querySelectorAll('[data-i18n]')) {
        const text = t(node.dataset.i18n, null);
        if (text == null) continue;
        const first = [...node.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
        if (first) first.textContent = text;
        else if (!node.firstElementChild) node.textContent = text;
    }
    for (const node of el.querySelectorAll('[data-i18n-ph]')) {
        const text = t(node.dataset.i18nPh, null);
        if (text != null) node.setAttribute('placeholder', text);
    }
    for (const node of el.querySelectorAll('[data-i18n-tip]')) {
        const text = t(node.dataset.i18nTip, null);
        if (text != null) node.setAttribute('data-tooltip', text);
    }
    for (const node of el.querySelectorAll('[data-i18n-title]')) {
        const text = t(node.dataset.i18nTitle, null);
        if (text != null) node.setAttribute('title', text);
    }
    // A few explanatory paragraphs are a sentence with <b> and <a> woven through it. Splitting those
    // into fragments would force every translator into English word order, so the whole paragraph
    // (markup and all) is one string. The value comes from our own bundled locale files, never from
    // the page or the network, so there is nothing here a site could inject into.
    for (const node of el.querySelectorAll('[data-i18n-html]')) {
        const text = t(node.dataset.i18nHtml, null);
        if (text != null) node.innerHTML = text;
    }
}

root.MephistoI18n = {
    LANGUAGES, LANG_CODES, DEFAULT_LANG,
    t, apply, use, setStrings, setFallback, fetchLocale, format,
    get lang() { return current; },
};

})(typeof self !== 'undefined' ? self : this);
