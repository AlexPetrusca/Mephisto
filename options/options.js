let activeTab;
let activeScrollspies;

document.addEventListener('DOMContentLoaded', function () {
    // init materialize
    let elemsCollapse = document.querySelectorAll('.collapsible');
    M.Collapsible.init(elemsCollapse, {});
    let elemsSidenav = document.querySelectorAll('.sidenav');
    M.Sidenav.init(elemsSidenav, {});

    // page injection logic
    let contentElem = document.getElementById('content');
    let titleElem = document.getElementById('title');
    let headElem = document.getElementById('head');
    let scriptsElem = document.getElementsByTagName('HEAD').item(0);

    function updateActiveTab(elem) {
        if (activeTab) {
            activeTab.classList.remove('active');
        }
        activeTab = elem.parentElement;
        activeTab.classList.add('active');
    }

    function injectHTML(elem) {
        let title = elem.href.split('#')[1];
        let xhr = new XMLHttpRequest();
        xhr.open('GET', `pages/${title}/${title}.html`, true);
        xhr.onreadystatechange = function () {
            if (this.readyState !== 4) return;
            if (this.status !== 200) return;

            // inject page title
            let pretitle = "-" + title;
            titleElem.innerText = pretitle.replace(/-[a-z]/g, (match) => {
                return " " + match.toUpperCase().substring(1);
            });

            // inject html
            contentElem.innerHTML = this.responseText;
            if (activeScrollspies) {
                activeScrollspies.forEach(scrollspy => {
                    scrollspy.destroy();
                });
            }
            let elemsScrollspy = document.querySelectorAll('.scrollspy');
            activeScrollspies = M.ScrollSpy.init(elemsScrollspy, {});
            headElem.scrollIntoView(true);

            // inject js
            if (!document.getElementById(`${title}-script`)) {
                let script = document.createElement("script");
                script.type = "text/javascript";
                script.src = `pages/${title}/${title}.js`;
                script.id = `${title}-script`;
                scriptsElem.appendChild(script);
            }

            broadcastEvent(elem);
        };
        xhr.send();
    }

    function broadcastEvent(elem) {
        let event = new Event('focus');
        event.value = elem.href.split('#')[1];
        contentElem.dispatchEvent(event);
    }

    window.onclick = function (e) {
        let elem = e.target;
        if (elem.nodeName === 'A' && elem.classList.contains('menu-item')) {
            updateActiveTab(elem);
            injectHTML(elem);
        }
    };

    let page = location.hash.substring(1) || 'about';
    let elem = document.getElementById(page);
    updateActiveTab(elem);
    injectHTML(elem);
});