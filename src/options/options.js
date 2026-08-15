import { require } from "./framework/require.js";

let registerPageScript;

// dark mode: a single class on <html>, toggled from the Appearance settings. Applied before
// anything renders and re-applied live when the toggle changes (window.mephistoApplyTheme).
function applyTheme() {
    const dark = JSON.parse(MephistoConfig.get('dark_mode') || 'false');
    document.documentElement.classList.toggle('dark', dark);
}
applyTheme();
MephistoConfig.ready.then(applyTheme); // re-apply once chrome.storage (source of truth) is loaded
window.mephistoApplyTheme = applyTheme;

// UI language, same shape as the theme: applied to whatever is on screen and re-applied live when
// the Appearance setting changes. This page swaps its content per route, so each page re-applies on
// render too (SettingsPage.onInit) -- this covers the shell (sidebar, title) and a live change.
async function applyLanguage(lang) {
    await MephistoI18n.use(lang || JSON.parse(MephistoConfig.get('language') || '"en"'));
    MephistoI18n.apply(document);
    document.documentElement.lang = MephistoI18n.lang;
    // Materialize copies data-tooltip into its own element when a tooltip is created, so an already
    // initialised tooltip keeps the old text until it is rebuilt.
    M.Tooltip.init(document.querySelectorAll('.tooltipped'), {enterDelay: 1000});
}
window.mephistoApplyLanguage = applyLanguage;

document.addEventListener('DOMContentLoaded', function () {
    applyTheme();
    let activeScrollspies;

    // init materialize. The menu is a FLAT list since 3.1.253 -- no accordion to initialise, and
    // nothing else on these pages uses one.
    const mSidenav = M.Sidenav.init(document.querySelectorAll('.sidenav'), {});

    // page injection logic
    const contentElem = document.querySelector('#content .container');
    const titleElem = document.getElementById('title');
    const headElem = document.getElementById('header');
    const stylesheetsElem = document.querySelector('head');

    function onClick(e) {
        injectPage(e.target.hash.substring(1));
        if (e.target.id === 'logo-container') {
            e.target.parentElement.classList.remove('active');
            document.getElementById('about').parentElement.classList.add('active');
        }
    }

    function updateActiveTab(elem) {
        location.hash = elem.hash;
        document.querySelectorAll('#nav-mobile li').forEach(elem => {
            if (!elem.classList.contains('open')) {
                elem.classList.remove('active');
            }
        });
        while (elem.id !== 'nav-mobile') {
            if (elem.tagName === 'LI') {
                elem.classList.add('active');
            } else if (elem.classList.contains('collapsible') && !elem.children[0].classList.contains('open')) {
                elem.M_Collapsible.close();
                elem.M_Collapsible.open();
            }
            elem = elem.parentElement;
        }
    }

    async function injectPage(pagePath) {
        updateActiveTab(document.getElementById(pagePath));
        const title = pagePath.substring(pagePath.lastIndexOf('/') + 1);
        const path = pagePath.substring(0, pagePath.lastIndexOf('/') + 1) + title;
        const componentPath = `pages/${path}/${title}`;

        // inject html
        const pageBody = await require(componentPath, 'html');
        contentElem.innerHTML = pageBody.innerHTML;
        activeScrollspies?.forEach(scrollspy => scrollspy.destroy());
        activeScrollspies = M.ScrollSpy.init(document.querySelectorAll('.scrollspy'), {});
        headElem.scrollIntoView(true);

        // disable cached stylesheets
        Array.from(document.getElementsByClassName('page-stylesheet'))
            .forEach((stylesheet) => stylesheet.disabled = true);

        // inject css OR re-enable cached css
        const pageStylesheet = document.getElementById(`${componentPath}-stylesheet`);
        if (pageStylesheet) {
            pageStylesheet.disabled = false;
        } else {
            const pageStyle = await require(componentPath, 'css');
            stylesheetsElem.appendChild(pageStyle);
        }

        // inject js
        const pageModule = await require(componentPath);
        pageModule.page?.onInit();

        // inject page title
        titleElem.innerText = pageModule.title;

        paintRanges();            // teal-fill the slider tracks up to the thumb (dark CSS reads var(--fill))
        setTimeout(paintRanges, 150); // fallback: some range values are set just after onInit
    }

    // set --fill (0-100%) on a range from its value; the dark-mode slider CSS paints the teal fill to it
    function paintRange(r) {
        const min = +r.min || 0, max = +r.max || 100;
        r.style.setProperty('--fill', ((r.value - min) / (max - min) * 100) + '%');
    }
    function paintRanges() {
        document.querySelectorAll('input[type=range]').forEach(paintRange);
    }
    document.addEventListener('input', e => { // live update while dragging any slider
        if (e.target.matches?.('input[type=range]')) paintRange(e.target);
    });

    document.querySelectorAll('#nav-mobile a.menu-item').forEach(elem => {
        elem.addEventListener('click', e => onClick(e));
    });

    injectPage(location.hash.substring(1) || 'settings/general');
});