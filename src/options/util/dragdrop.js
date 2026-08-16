// DROP A PGN ANYWHERE ON THE PAGE -- a button and a paste box are two steps for what should be one.
// One helper for both pages that take a PGN (Analysis and Game Review), so the two cannot drift:
// the whole section is the target (aiming at the one textarea is fiddly), the box lights up so the
// drop has somewhere visible to land, and a drag WITHOUT files -- a text selection, an image dragged
// off the page -- falls through untouched.
export function wirePgnDrop(zone, highlightEl, onText) {
    if (!zone) return;
    const hasFile = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    zone.addEventListener('dragover', (e) => {
        if (!hasFile(e)) return;
        e.preventDefault();
        highlightEl?.classList.add('drop-ready');
    });
    zone.addEventListener('dragleave', () => highlightEl?.classList.remove('drop-ready'));
    zone.addEventListener('drop', async (e) => {
        if (!hasFile(e)) return;
        e.preventDefault();
        highlightEl?.classList.remove('drop-ready');
        const f = [...e.dataTransfer.files].find(x => /\.(pgn|txt)$/i.test(x.name) || x.type.startsWith('text/'))
            || e.dataTransfer.files[0];
        if (f) onText(await f.text());
    });
}
