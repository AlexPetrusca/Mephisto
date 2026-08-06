// Self-update from this project's own GitHub releases.
//
// STRICT OPT-IN, and the gate is OURS. Nothing here runs until the Updates section is switched on,
// which is the same moment Chrome is asked for the two release hosts. install() refuses outright
// while that grant is missing, and the buttons stay disabled -- that check is the enforcement.
//
// MEASURED, because the obvious assumption is wrong: in Chrome 151 an extension PAGE can fetch and
// read any cross-origin URL with no host permission at all. A control fetch of example.com and a
// full 5,884,500-byte read of a real release asset both succeeded from the options page with
// nothing granted (headless Chrome 151.0.7922.72, macOS, 2026-08-06). So the permission is not what
// makes the download possible. It is kept anyway, for two reasons that are worth the four lines:
// it is a visible, revocable record of what was agreed to (chrome://extensions shows it, and
// switching the toggle off hands it back), and it keeps working on any build that DOES enforce CORS
// here. What it is not is a substitute for the hasPermission() check below.
//
// WHY THIS IS NEEDED AT ALL. Chrome never auto-updates an unpacked extension -- `update_url` is
// ignored for anything loaded through Developer mode. The only route left is to rewrite the
// extension's own folder on disk and call chrome.runtime.reload(). Nothing can hand an extension a
// writable filesystem path except the user, through showDirectoryPicker(), so the folder is picked
// once and the handle kept in IndexedDB.
//
// THE EXTENSION ID SURVIVES, which is the point. An unpacked extension's id comes from the absolute
// path of its folder (or from manifest "key" where one is set) -- never from its contents. Writing
// in place keeps the id, so every native-messaging manifest naming it keeps working. Re-installing
// from a fresh zip into a new folder is what breaks that, and is what this exists to avoid.
//
// ONLY THE UPDATE ARCHIVE IS EVER APPLIED. mephisto-<v>-update.zip is about six megabytes; the full
// one is 585 and would have to be held in memory to be read. The full archive is refused, twice --
// once on Content-Length and once on its contents.
const MephistoUpdater = (function () {
    const REPO = 'IchNukeDichWeg/Mephisto';
    // Deliberately narrow: the release-download path of ONE repository, not github.com. The second
    // host is where every asset download is redirected to, and its path is an opaque signed blob, so
    // that one cannot be narrowed at all. Must stay identical to manifest optional_host_permissions,
    // or the request is a silent no-op and the toggle can never go on.
    const ORIGINS = [
        `https://github.com/${REPO}/releases/download/*`,
        'https://release-assets.githubusercontent.com/*',
    ];
    const DB = 'mephisto-updater', STORE = 'h', KEY = 'root';
    const MAX_ZIP = 64 * 1024 * 1024; // the update archive is ~6 MB; the full one is 585

    // --- the picked folder, remembered ----------------------------------------------------------
    // A FileSystemDirectoryHandle is structured-cloneable, so IndexedDB can hold it across restarts.
    // chrome.storage cannot: it JSON-serializes, which turns a handle into `{}`.
    function idb() {
        return new Promise((res, rej) => {
            const r = indexedDB.open(DB, 1);
            r.onupgradeneeded = () => r.result.createObjectStore(STORE);
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
    }
    async function idbDo(mode, fn) {
        const db = await idb();
        try {
            return await new Promise((res, rej) => {
                const r = fn(db.transaction(STORE, mode).objectStore(STORE));
                r.onsuccess = () => res(r.result);
                r.onerror = () => rej(r.error);
            });
        } finally {
            db.close();
        }
    }
    const handleGet = () => idbDo('readonly', s => s.get(KEY));
    const handlePut = (v) => idbDo('readwrite', s => s.put(v, KEY));
    const handleDel = () => idbDo('readwrite', s => s.delete(KEY));

    // --- permission -----------------------------------------------------------------------------
    // Both calls need a user gesture, which is why the caller wires them straight to the toggle
    // rather than doing anything clever first.
    const hasPermission = () => chrome.permissions.contains({origins: ORIGINS});
    const requestPermission = () => chrome.permissions.request({origins: ORIGINS});
    const dropPermission = () => chrome.permissions.remove({origins: ORIGINS});

    // --- the folder -----------------------------------------------------------------------------
    // Verified to be THIS extension before it is ever written to. A mis-picked directory would
    // otherwise get a few hundred files sprayed into it, and there is no undo for that. The name
    // comes from the RUNNING manifest, so the check cannot drift from whatever this build calls
    // itself -- the fork and the local tree share it by construction.
    async function verifyFolder(handle) {
        let manifest;
        try {
            manifest = JSON.parse(await (await handle.getFileHandle('manifest.json')).getFile()
                .then(f => f.text()));
        } catch (e) {
            throw new Error('No manifest.json in that folder — pick the folder you loaded as an unpacked extension.');
        }
        const want = chrome.runtime.getManifest().name;
        if (manifest.name !== want) {
            throw new Error(`That folder holds "${manifest.name || 'something else'}", not ${want}.`);
        }
        return manifest;
    }

    async function pickFolder() {
        const handle = await showDirectoryPicker({id: 'mephisto-root', mode: 'readwrite'});
        const manifest = await verifyFolder(handle); // throws BEFORE anything is remembered
        await handlePut(handle);
        return {name: handle.name, version: manifest.version};
    }

    // A handle survives a browser restart; its write grant does not always come back with it. So the
    // grant is re-checked on every use and re-requested when asked for -- and that request needs a
    // user gesture, which is why install() does it before the download rather than after.
    async function folder({prompt = false} = {}) {
        const handle = await handleGet();
        if (!handle) return null;
        const opts = {mode: 'readwrite'};
        let state = await handle.queryPermission(opts);
        if (state !== 'granted' && prompt) state = await handle.requestPermission(opts);
        return state === 'granted' ? handle : null;
    }

    // --- release lookup -------------------------------------------------------------------------
    // Goes through the service worker's updateCheck rather than fetching here: that one already
    // owns the version compare and a 12h cache, and the unauthenticated GitHub API allows 60
    // requests/hour/IP. One implementation, one cache.
    function check({force = false} = {}) {
        return new Promise((res, rej) => {
            chrome.runtime.sendMessage({updateCheck: {force}}, (r) => {
                if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
                if (!r || r.error) return rej(new Error(r?.error || 'no answer from the extension'));
                res(r);
            });
        });
    }

    // --- zip ------------------------------------------------------------------------------------
    // `git archive --format=zip -9` writes exactly two storage methods -- 0 (stored, for whatever
    // did not compress) and 8 (deflate) -- and no zip64 records, because the update archive is six
    // megabytes with a few hundred entries. Anything else is refused rather than guessed at.
    function readZip(buf) {
        const dv = new DataView(buf);
        // The end-of-central-directory record is found by scanning BACK for its signature: it ends
        // with a variable-length comment, so it sits at no fixed offset. The comment is capped at
        // 65535 bytes, which bounds the scan.
        let eocd = -1;
        for (let i = buf.byteLength - 22; i >= 0 && i > buf.byteLength - 22 - 65536; i--) {
            if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('Not a zip file (no end-of-central-directory record).');
        const count = dv.getUint16(eocd + 10, true);
        const cdOff = dv.getUint32(eocd + 16, true);
        if (count === 0xffff || cdOff === 0xffffffff) throw new Error('Zip64 archives are not supported.');
        const dec = new TextDecoder();
        const entries = [];
        let p = cdOff;
        for (let i = 0; i < count; i++) {
            if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt zip central directory.');
            entries.push({
                method: dv.getUint16(p + 10, true),
                csize: dv.getUint32(p + 20, true),
                usize: dv.getUint32(p + 24, true),
                lho: dv.getUint32(p + 42, true),
                name: dec.decode(new Uint8Array(buf, p + 46, dv.getUint16(p + 28, true))),
            });
            p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
        }
        return entries;
    }

    async function extract(buf, e) {
        const dv = new DataView(buf);
        if (dv.getUint32(e.lho, true) !== 0x04034b50) throw new Error(`Corrupt local header for ${e.name}.`);
        // The data offset has to come from the LOCAL header's own name/extra lengths. They are
        // routinely not the central directory's -- writers put different extra fields in each -- and
        // reusing the central values silently reads from the wrong offset.
        const start = e.lho + 30 + dv.getUint16(e.lho + 26, true) + dv.getUint16(e.lho + 28, true);
        const raw = new Uint8Array(buf, start, e.csize);
        if (e.method === 0) return raw;
        if (e.method !== 8) throw new Error(`${e.name}: unsupported compression method ${e.method}.`);
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const out = new Uint8Array(await new Response(stream).arrayBuffer());
        if (out.byteLength !== e.usize) throw new Error(`${e.name}: inflated to the wrong size.`);
        return out;
    }

    // Everything is parsed, inflated and checked BEFORE a single byte is written. A half-applied
    // update is an extension that will not load, and the recovery for that is the 585 MB download --
    // so a bad archive has to fail while the folder is still untouched.
    async function readUpdateArchive(buf, version) {
        const prefix = `Mephisto-${version}/`;
        const out = [];
        for (const e of readZip(buf)) {
            if (e.name.endsWith('/')) continue; // directory record; directories are created on demand
            if (!e.name.startsWith(prefix)) throw new Error(`Unexpected path in the archive: ${e.name}`);
            const path = e.name.slice(prefix.length);
            // An archive is untrusted input even from our own release page. getDirectoryHandle('..')
            // does reject on its own, but a backslash or a leading slash is not covered by that, and
            // the right answer to any of them is to refuse the whole archive rather than skip a file.
            if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
                throw new Error(`Unsafe path in the archive: ${e.name}`);
            }
            out.push({path, bytes: await extract(buf, e)});
        }
        const have = new Set(out.map(f => f.path));
        for (const need of ['manifest.json', 'src/popup/popup.js', 'src/scripts/content-script.js', 'lib/chess.js']) {
            if (!have.has(need)) throw new Error(`The archive is missing ${need}.`);
        }
        // The full archive would apply perfectly well here and take 585 MB of memory to do it.
        // Refuse it by the one directory that tells the two apart.
        if ([...have].some(p => p.startsWith('lib/engine/'))) {
            throw new Error('That is the full archive, not the update one.');
        }
        const manifest = JSON.parse(new TextDecoder().decode(out.find(f => f.path === 'manifest.json').bytes));
        if (manifest.version !== version) {
            throw new Error(`The archive says v${manifest.version} but the release says v${version}.`);
        }
        return out;
    }

    // --- writing --------------------------------------------------------------------------------
    async function writeFile(root, relPath, bytes) {
        const parts = relPath.split('/');
        const name = parts.pop();
        let dir = root;
        for (const part of parts) dir = await dir.getDirectoryHandle(part, {create: true});
        const w = await (await dir.getFileHandle(name, {create: true})).createWritable();
        await w.write(bytes);
        await w.close();
    }

    // A "key" in the INSTALLED manifest pins the extension id. The published archive carries none --
    // the fork ships without one -- so applying it verbatim would drop the key and change the id,
    // taking every native-messaging registration with it. Carry the installed one across.
    function carryKey(archiveManifestBytes, installed) {
        const m = JSON.parse(new TextDecoder().decode(archiveManifestBytes));
        if (!installed.key || m.key) return null;
        return new TextEncoder().encode(JSON.stringify({key: installed.key, ...m}, null, 2) + '\n');
    }

    // --- the whole thing ------------------------------------------------------------------------
    async function install(onStatus = () => {}) {
        if (!(await hasPermission())) throw new Error('Automatic updates are switched off.');
        const dir = await folder({prompt: true});
        if (!dir) throw new Error('Choose the extension folder first.');
        const installed = await verifyFolder(dir); // re-checked every run, not only when it was picked

        onStatus('Checking for a newer release…');
        const rel = await check({force: true});
        if (!rel.latest) throw new Error('Could not reach GitHub.');
        if (!rel.newer) return {already: true, version: rel.latest};
        if (!rel.asset) throw new Error(`Release v${rel.latest} has no update archive — use the full zip.`);

        onStatus(`Downloading v${rel.latest}…`);
        const res = await fetch(rel.asset, {credentials: 'omit'});
        if (!res.ok) throw new Error(`Download failed (${res.status}).`);
        // Checked before buffering, so a mis-named full archive costs one header rather than 585 MB.
        if (+res.headers.get('content-length') > MAX_ZIP) throw new Error('That download is far too big to be the update archive.');
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_ZIP) throw new Error('That download is far too big to be the update archive.');

        onStatus('Reading the archive…');
        const files = await readUpdateArchive(buf, rel.latest);
        const keyed = carryKey(files.find(f => f.path === 'manifest.json').bytes, installed);
        if (keyed) files.find(f => f.path === 'manifest.json').bytes = keyed;

        let n = 0;
        for (const f of files) {
            await writeFile(dir, f.path, f.bytes);
            if (++n % 20 === 0 || n === files.length) onStatus(`Writing… ${n}/${files.length}`);
        }
        return {installed: rel.latest, from: installed.version, files: files.length};
    }

    return {
        REPO, ORIGINS,
        hasPermission, requestPermission, dropPermission,
        // `folder` answers null when the write grant has lapsed (it does across restarts);
        // `savedFolder` answers whether one was ever chosen, which is a different question and the
        // one the settings page needs to decide what to tell you.
        pickFolder, folder, savedFolder: handleGet, forgetFolder: handleDel, verifyFolder,
        check, install,
        // exported for the test suite, which drives them against a real archive and a stub directory
        _readZip: readZip, _extract: extract, _readUpdateArchive: readUpdateArchive,
        _writeFile: writeFile, _carryKey: carryKey,
    };
})();

// The options page loads this as a plain script; the test suite loads the same file into a vm.
if (typeof module !== 'undefined' && module.exports) module.exports = MephistoUpdater;
