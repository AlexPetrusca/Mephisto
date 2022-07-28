let registerPageScript;

document.addEventListener('DOMContentLoaded', function () {
    let activeScrollspies;

    // init materialize
    const mCollapsible = M.Collapsible.init(document.querySelectorAll('.collapsible'), {
        onOpenStart: elem => elem.classList.add('open'),
        onCloseStart: elem => elem.classList.remove('open')
    });
    const mSidenav = M.Sidenav.init(document.querySelectorAll('.sidenav'), {});

    // page injection logic
    let contentElem = document.getElementById('content');
    const titleElem = document.getElementById('title');
    const headElem = document.getElementById('head');
    const stylesheetsElem = document.getElementsByTagName('HEAD').item(0);

    function onClick(e) {
        injectHTML(e.target);
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

    function injectHTML(elem) {
        updateActiveTab(elem);
        const hash = elem.hash.substring(1);
        const title = hash.substring(hash.lastIndexOf('/') + 1);
        const path = hash.substring(0, hash.lastIndexOf('/') + 1) + title;
        const componentPath = `pages/${path}/${title}`;

        const xhr = new XMLHttpRequest();
        xhr.open('GET', `${componentPath}.html`, true);
        xhr.onreadystatechange = function () {
            if (this.readyState !== 4) return;
            if (this.status !== 200) return;

            // inject page title
            const pretitle = '-' + title;
            titleElem.innerText = pretitle.replace(/-[a-z]/g, (match) => {
                return ' ' + match.toUpperCase().substring(1);
            });

            // inject html
            contentElem.innerHTML = this.responseText;
            if (activeScrollspies) {
                activeScrollspies.forEach(scrollspy => {
                    scrollspy.destroy();
                });
            }
            const elemsScrollspy = document.querySelectorAll('.scrollspy');
            activeScrollspies = M.ScrollSpy.init(elemsScrollspy, {});
            headElem.scrollIntoView(true);

            // disable cached stylesheets
            const loadedStylesheets = document.getElementsByClassName('page-stylesheet');
            Array.from(loadedStylesheets).forEach((stylesheet) => {
                stylesheet.disabled = true;
            });

            // inject css OR re-enable cached css
            const pageStylesheet = document.getElementById(`${title}-stylesheet`);
            if (pageStylesheet) {
                pageStylesheet.disabled = false;
            } else {
                const stylesheet = document.createElement('link');
                stylesheet.rel = 'stylesheet';
                stylesheet.href = `${componentPath}.css`;
                stylesheet.id = `${title}-stylesheet`;
                stylesheet.className = 'page-stylesheet';
                stylesheetsElem.appendChild(stylesheet);
            }

            // inject js
            let script = document.createElement("script");
            script.type = "text/javascript";
            script.src = `${componentPath}.js`;
            script.id = `${title}-script`;
            script.name = `${title}`;
            contentElem.appendChild(script);
        };
        xhr.send();
    }

    document.querySelectorAll('#nav-mobile a.menu-item').forEach(elem => {
        elem.addEventListener('click', e => onClick(e));
    });

    registerPageScript = (pageScript) => {
        pageScript();
    };

    const pagePath = location.hash.substring(1) || 'settings/general';
    injectHTML(document.getElementById(pagePath));
});