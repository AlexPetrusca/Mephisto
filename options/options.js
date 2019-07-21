let registerPageScript;

document.addEventListener('DOMContentLoaded', function () {
    let activeTab;
    let activeScrollspies;

    // init materialize
    const elemsCollapse = document.querySelectorAll('.collapsible');
    M.Collapsible.init(elemsCollapse, {});
    const elemsSidenav = document.querySelectorAll('.sidenav');
    M.Sidenav.init(elemsSidenav, {});

    // page injection logic
    let contentElem = document.getElementById('content');
    const titleElem = document.getElementById('title');
    const headElem = document.getElementById('head');
    const stylesheetsElem = document.getElementsByTagName('HEAD').item(0);

    function updateActiveTab(elem) {
        if (activeTab) {
            activeTab.classList.remove('active');
        }
        activeTab = elem.parentElement;
        activeTab.classList.add('active');
    }

    function injectHTML(elem) {
        const title = elem.href.split('#')[1];
        if (title === titleElem.innerText.toLowerCase()) {
            return;
        }

        const xhr = new XMLHttpRequest();
        xhr.open('GET', `pages/${title}/${title}.html`, true);
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
                stylesheet.href = `pages/${title}/${title}.css`;
                stylesheet.id = `${title}-stylesheet`;
                stylesheet.className = 'page-stylesheet';
                stylesheetsElem.appendChild(stylesheet);
            }

            // inject js
            let script = document.createElement("script");
            script.type = "text/javascript";
            script.src = `pages/${title}/${title}.js`;
            script.id = `${title}-script`;
            script.name = `${title}`;
            contentElem.appendChild(script);
        };
        xhr.send();
    }

    window.onclick = function (e) {
        const elem = e.target;
        if (elem.nodeName === 'A' && elem.classList.contains('menu-item')) {
            updateActiveTab(elem);
            injectHTML(elem);
        }
    };

    registerPageScript = function(pageScript) {
        pageScript();
    };

    const page = location.hash.substring(1) || 'about';
    const elem = document.getElementById(page);
    updateActiveTab(elem);
    injectHTML(elem);
});