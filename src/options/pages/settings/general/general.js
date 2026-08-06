import {define} from "../../../framework/require.js";
import {SettingsPage} from "../../../util/SettingsPage.js";

// What a move that gives up `lossCp` centipawns is worth. Both formulas are Lichess's own, so a cp
// figure here reads the same as a Lichess game review:
//   winPercent -- lila WinPercent.scala, the PR #11148 regression (NOT Stockfish's own formula)
//   accuracy   -- lila AccuracyPercent.scala, derived from the before/after win%
// Taken from an EQUAL position (win% 50 before the move), which is the standard way these are
// illustrated: 110cp = a 10% win-drop = Inaccuracy, 230cp = 20% = Mistake, 377cp = 30% = Blunder,
// which is where the defaults sit. Module scope because the per-row readouts and the weighted
// summary both need it, and two copies of a formula drift.
function moveQuality(lossCp) {
    const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
    const drop = 50 - winPct(-lossCp); // our win% after a move that loses this much, from equal
    const acc = Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669 + 1));
    return {acc, drop};
}

// The seven mix categories paired with the threshold that defines each. Top move has no threshold:
// it IS the best move, so it gives up nothing.
const HUMANIZE_BANDS = [
    ['humanize_top', null],
    ['humanize_second', 'humanize_cp_second'],
    ['humanize_third', 'humanize_cp_third'],
    ['humanize_fourth', 'humanize_cp_fourth'],
    ['humanize_inaccuracy', 'humanize_cp_inaccuracy'],
    ['humanize_mistake', 'humanize_cp_mistake'],
    ['humanize_blunder', 'humanize_cp_blunder'],
];

class GeneralSettings extends SettingsPage {
    init() {
        M.FormSelect.init(document.querySelectorAll('select'), {});
        M.Range.init(document.querySelectorAll('input[type=range]'), {});
        M.Tooltip.init(document.querySelectorAll('.tooltipped'), {enterDelay: 1000});
        const engine_select = this.registerFormElement('engine', 'Engine:', 'select', 'stockfish-dev-nnue');
        const variant_select = this.registerFormElement('variant', 'Variant:', 'select', 'chess');
        this.registerFormElement('fourpc_mode', 'Four-player Mode:', 'select', 'auto');
        const elo_input = this.registerFormElement('elo', 'Elo:', 'input', 0);
        this.registerFormElement('compute_time', 'Stockfish Compute Time (ms):', 'input', 300);
        this.registerFormElement('fen_refresh', 'Fallback Poll Interval (ms):', 'input', 1000);
        const multipv_range = this.registerFormElement('multiple_lines', 'Multiple Lines:', 'range', 1);
        const threads_range = this.registerFormElement('threads', 'Threads:', 'range', MephistoConfig.defaultThreads());
        const memory_range = this.registerFormElement('memory', 'Memory:', 'range', 512);
        this.registerFormElement('computer_evaluation', 'Show Computer Evaluation:', 'checkbox', true);
        this.registerFormElement('threat_analysis', 'Show Threat Analysis', 'checkbox', false);
        this.registerFormElement('simon_says_mode', '"Hand and Brain" Mode:', 'checkbox', false);
        this.registerFormElement('autoplay', 'Autoplay:', 'checkbox', false);
        this.registerFormElement('premove', 'Premove:', 'checkbox', false);
        this.registerFormElement('ponder', 'Pondering:', 'checkbox', false);
        this.registerFormElement('tablebase', 'Endgame Tablebase:', 'checkbox', false);
        this.registerFormElement('move_reason', 'Explain Moves:', 'checkbox', false);
        this.registerFormElement('hide_opponent', 'Hide Opponent Name:', 'checkbox', false);
        this.registerFormElement('explorer', 'Opening Explorer:', 'checkbox', false);
        this.registerFormElement('book_play', 'Play Book Moves:', 'checkbox', false);
        this.registerFormElement('explorer_db', 'Opening Database:', 'select', 'masters');
        this.registerFormElement('background_play', 'Background Play:', 'checkbox', false);
        this.registerFormElement('help_mode', 'Help Mode:', 'checkbox', false);
        this.registerFormElement('humanize', 'Humanize:', 'checkbox', false);
        this.registerFormElement('clock_mode', 'Clock Mode:', 'checkbox', false);
        this.registerFormElement('mirror_mode', 'Mirror Time:', 'checkbox', false);
        this.registerFormElement('manual_mode', 'Manual Mode:', 'checkbox', false);
        this.registerFormElement('opp_alert', 'Opponent Mistake Alert:', 'checkbox', false);
        this.registerFormElement('verbose_log', 'Verbose Logging:', 'checkbox', false);
        this.initSteppers();
        this.initHumanizeMix();
        this.initHumanizeThresholds();
        this.initUiMode();
        this.initHotkeys();
        this.initPuzzleDb();
        this.initUpdater();
        this.initCopyDiagnostics();
        this.registerFormElement('puzzle_mode', 'Puzzle Mode:', 'checkbox', false);
        this.registerFormElement('python_autoplay_backend', 'Python Autoplay Backend:', 'checkbox', false);
        this.registerFormElement('think_time', 'Simulated Think Time (ms):', 'input', 0);
        this.registerFormElement('think_variance', 'Simulated Think Variance (ms):', 'input', 0);
        this.registerFormElement('move_time', 'Simulated Move Time (ms):', 'input', 400);
        this.registerFormElement('move_variance', 'Simulated Move Variance (ms):', 'input', 400);
        const engineLabelTooltiped = document.querySelector('#engine-label-tooltiped');
        const engineLabelUntooltiped = document.querySelector('#engine-label-untooltiped');
        for (const range of [multipv_range, threads_range, memory_range]) {
            range.registerChangeListener(() => {
                let section = range.elem;
                while (!section.classList.contains('section')) {
                    section = section.parentElement
                }
                // `.set-val` explicitly, NOT the first `.value` in the row: M.Range injects its own
                // <span class="value"> inside the drag thumb, and since the readout now sits AFTER
                // the input, a bare `.value` lookup finds that hidden bubble instead. Falls back for
                // a stale cached page whose markup predates .set-val.
                const out = section.querySelector('.set-val') || section.querySelector('.value');
                if (out) out.innerText = range.getValue();
            });
        }
        engine_select.registerChangeListener(() => {
            let section = variant_select.elem;
            while (!section.classList.contains('section')) {
                section = section.parentElement
            }
            // Engines with no UCI_Elo. The panel already hid the row for these (NO_ELO_ENGINES in
            // popup.js, which this must match); this page did not, so it kept offering a strength
            // cap that nothing ever applied -- maia picks its strength by which net is loaded, and
            // tetrarch speaks its own four-player protocol and has no such option at all.
            const NO_ELO = ['maia', 'maia3', 'tetrarch-native'];
            document.getElementById('elo_section')
                ?.classList.toggle('hidden', NO_ELO.includes(engine_select.getValue()));
            // The four-player mode override replaces Variant for Tetrarch: a different question
            // (which RULES this board plays by) for the one engine it applies to.
            document.getElementById('fourpc_mode_section')
                ?.classList.toggle('hidden', engine_select.getValue() !== 'tetrarch-native');
            if (['fairy-stockfish-14-nnue', 'fairy-native'].includes(engine_select.getValue())) {
                section.classList.remove('hidden');
            } else {
                section.classList.add('hidden');
                // Chess960 survives an engine switch: every mainline Stockfish plays it via
                // UCI_Chess960 (sent at engine init). Only fairy-only variants reset.
                if (!['chess', 'fischerandom'].includes(variant_select.getValue())) {
                    variant_select.setValue('chess');
                }
            }
            if (engine_select.getValue() === 'remote') {
                engineLabelTooltiped.classList.remove('hidden');
                engineLabelUntooltiped.classList.add('hidden');
            } else {
                engineLabelTooltiped.classList.add('hidden');
                engineLabelUntooltiped.classList.remove('hidden');
            }
        })
    }

    // Humanize move mix: five independent slider+number pairs. No auto-rescaling -- the user
    // balances them by hand, and the Total row shows the sum plus what's off: "90 (-10)" means
    // add 10 somewhere, "110 (+10)" means remove 10. (The popup normalizes by the sum when
    // picking, so an off-100 mix still behaves proportionally in the meantime.) NOT FormElements:
    // one logical setting spans two inputs per row. Values persist per-key in localStorage; the
    // popup reads them fresh on every pick, so edits apply to the very next move.
    // Panel Style: 'floating' (in-page overlay) or 'popup' (toolbar bubble = no page footprint).
    // Unlike every other setting this one lives in chrome.storage.local, NOT localStorage: the
    // background service worker flips the toolbar popup on/off (chrome.action.setPopup) and can't
    // read the popup page's localStorage. Writing it fires chrome.storage.onChanged in the worker.
    // Hotkeys: one rebindable key per action, stored together in config.hotkeys (a single JSON key,
    // so settings export/import carries them). DEFAULTS + labels must match content-script.js's
    // HOTKEY_DEFAULTS. Clicking a key captures the next keydown (Esc cancels, Backspace/Delete clears).
    // [-] value [+] beside a number field. Steps by the input's OWN `step` and clamps to its own
    // min/max, so one handler serves ms fields (25), the poll interval (50) and Elo (10) alike.
    // Dispatches 'change' because that -- not 'input' -- is what FormElement persists on.
    initSteppers() {
        for (const btn of document.querySelectorAll('.set-step-btn')) {
            btn.addEventListener('click', () => {
                const input = btn.parentElement.querySelector('input[type=number]');
                if (!input) return;
                const step = +input.step || 1;
                let val = (+input.value || 0) + (+btn.dataset.step) * step;
                if (input.min !== '') val = Math.max(+input.min, val);
                if (input.max !== '') val = Math.min(+input.max, val);
                input.value = val;
                input.dispatchEvent(new Event('change', {bubbles: true}));
            });
        }
    }

    initHotkeys() {
        const container = document.getElementById('hotkey_rows');
        const resetBtn = document.getElementById('hotkey_reset_btn');
        if (!container || !resetBtn) return; // stale cached page html
        const DEFAULTS = MephistoConfig.HOTKEY_DEFAULTS; // shared source (config-store.js)
        const LABELS = {
            manual_play: 'Play move (Manual Mode)', autoplay: 'Toggle Autoplay', premove: 'Toggle Premove',
            help_mode: 'Toggle Help Mode', humanize: 'Toggle Humanize', clock_mode: 'Toggle Clock Mode',
            mirror_mode: 'Toggle Mirror Time', manual_mode: 'Toggle Manual Mode', eval_bar: 'Toggle Eval Bar',
            eval_history: 'Toggle Eval History', tablebase: 'Toggle Endgame Tablebase',
            puzzle_mode: 'Toggle Puzzle Mode', explorer: 'Toggle Opening Explorer',
            book_play: 'Toggle Book Moves', copy_fen: 'Copy FEN', copy_pgn: 'Copy PGN', copy_diagnostics: 'Copy Diagnostics',
            redetect: 'Re-detect game',
        };
        const ORDER = ['manual_play', 'manual_mode', 'autoplay', 'premove', 'explorer', 'book_play',
            'help_mode', 'humanize', 'clock_mode', 'mirror_mode', 'eval_bar', 'eval_history', 'tablebase', 'puzzle_mode',
            'copy_fen', 'copy_pgn', 'copy_diagnostics', 'redetect'];
        // same normalization as the content-script listener, so what we store matches what it compares
        const keyString = (e) => {
            const parts = [];
            if (e.ctrlKey) parts.push('Ctrl');
            if (e.altKey) parts.push('Alt');
            if (e.shiftKey) parts.push('Shift');
            if (e.metaKey) parts.push('Meta');
            parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
            return parts.join('+');
        };
        const pretty = (k) => !k ? '—' : k.split('+').map(p => p === ' ' ? 'Space' : (p.length === 1 ? p.toUpperCase() : p)).join(' + ');
        const load = () => { try { return {...DEFAULTS, ...(JSON.parse(MephistoConfig.get('hotkeys')) || {})}; } catch (e) { return {...DEFAULTS}; } };
        const save = (obj) => MephistoConfig.set('hotkeys', JSON.stringify(obj));
        let bindings = load();
        let capturing = null; // the action currently being rebound

        const render = () => {
            container.innerHTML = '';
            for (const action of ORDER) {
                const row = document.createElement('div');
                row.className = 'set-key';
                const label = document.createElement('span');
                label.textContent = LABELS[action];
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = (capturing === action) ? 'capturing' : '';
                btn.textContent = (capturing === action) ? 'press a key…' : pretty(bindings[action]);
                btn.addEventListener('click', () => { capturing = (capturing === action) ? null : action; render(); });
                row.append(label, btn);
                container.appendChild(row);
            }
        };
        // one document-level capture listener; only acts while rebinding
        document.addEventListener('keydown', (e) => {
            if (!capturing) return;
            e.preventDefault(); e.stopPropagation();
            if (e.key === 'Escape') { capturing = null; return render(); }
            if (e.key === 'Backspace' || e.key === 'Delete') { bindings[capturing] = ''; save(bindings); capturing = null; return render(); }
            if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return; // wait for the real key
            bindings[capturing] = keyString(e);
            save(bindings);
            capturing = null;
            render();
        }, true);
        resetBtn.addEventListener('click', () => { MephistoConfig.remove('hotkeys'); bindings = {...DEFAULTS}; capturing = null; render(); });
        render();
    }

    initUiMode() {
        const sel = document.getElementById('ui_mode_select');
        if (!sel) return; // stale cached page html
        chrome.storage.local.get('ui_mode', ({ui_mode}) => { sel.value = ui_mode || 'floating'; });
        sel.addEventListener('change', () => chrome.storage.local.set({ui_mode: sel.value}));
    }

    initHumanizeMix() {
        const MIX = [
            ['humanize_top', 50], ['humanize_second', 40], ['humanize_third', 4],
            ['humanize_fourth', 0], ['humanize_inaccuracy', 0],
            ['humanize_mistake', 5], ['humanize_blunder', 1],
        ];
        // `range` is optional: the mix is a table of number fields now, and the sliders it used to
        // carry are gone. Kept nullable rather than deleted so a stale cached page still works.
        const rows = MIX.map(([key, dflt]) => ({
            key, dflt,
            range: document.getElementById(`${key}_mixrange`),
            num: document.getElementById(`${key}_mixnum`),
        }));
        const total = document.getElementById('humanize_mix_total');
        if (!rows.every(r => r.num) || !total) return; // stale cached page html
        const paint = (el) => // dark-mode slider fill (options.js paints only on user input)
            el?.style.setProperty('--fill', ((el.value - el.min) / (el.max - el.min) * 100) + '%');
        const load = (key, dflt) => {
            try {
                const v = JSON.parse(MephistoConfig.get(key));
                return (v != null && isFinite(+v)) ? +v : dflt;
            } catch (e) {
                return dflt;
            }
        };

        const updateTotal = () => {
            const sum = rows.reduce((a, r) => a + (+r.num.value || 0), 0);
            const diff = sum - 100;
            total.textContent = (diff === 0) ? '100 ✓' : `${sum} (${diff > 0 ? '+' : ''}${diff})`;
            total.classList.toggle('ok', diff === 0);
            total.classList.toggle('off', diff !== 0);
        };

        const set = (row, val, persist = true) => {
            val = Math.min(100, Math.max(0, Math.round(+val) || 0));
            if (row.range) row.range.value = val;
            row.num.value = val;
            paint(row.range);
            if (persist) MephistoConfig.set(row.key, val);
            updateTotal();
            this.updateHumanizeSummary(); // a share moved, so the weighting moved
        };

        rows.forEach(r => {
            set(r, load(r.key, r.dflt), false); // initial sync, don't churn storage on page open
            r.range?.addEventListener('input', () => set(r, r.range.value));
            r.num.addEventListener('change', () => set(r, r.num.value));
        });
    }

    // The whole mix in one number, in the Total row's Accuracy cell: each category's accuracy
    // weighted by the share it is actually played. Reads live off the inputs rather than off stored
    // config, so it answers for what is on screen right now -- including a value typed but not yet
    // committed by a change event.
    //
    // Normalized by the ACTUAL sum, not by 100. The popup picks proportionally, so a mix totalling
    // 90 or 110 still plays those ratios, and this has to describe what will happen rather than what
    // a corrected mix would do. That also keeps it meaningful while the total is mid-edit and red.
    updateHumanizeSummary() {
        const cell = document.getElementById('humanize_mix_summary');
        if (!cell) return; // stale cached page html
        const num = (id) => +document.getElementById(id)?.value || 0;
        let share = 0, acc = 0, drop = 0;
        for (const [mixKey, cpKey] of HUMANIZE_BANDS) {
            const s = num(`${mixKey}_mixnum`);
            if (s <= 0) continue; // a category never played contributes nothing, not a zero
            const q = moveQuality(cpKey ? num(`${cpKey}_num`) : 0);
            share += s;
            acc += s * q.acc;
            drop += s * q.drop;
        }
        cell.textContent = share > 0
            ? `${Math.round(acc / share)}% acc · ${Math.round(drop / share)}% drop`
            : '—';
    }

    // Per-category centipawn thresholds, each with a live accuracy/win-drop readout. The two formulas
    // are Lichess's own, so "what does this cp cost" reads the same as a Lichess game review:
    //   winPercent(cp)  -- lila WinPercent.scala, the PR #11148 regression (NOT SF's own formula)
    //   accuracy        -- lila AccuracyPercent.scala, from the before/after win%
    // The readout takes an equal position as the reference (win% 50 before the move), the standard way
    // these are illustrated: a 110cp loss is a 10% win-drop = Inaccuracy, 230cp = 20% = Mistake,
    // 377cp = 30% = Blunder -- which is where the defaults sit.
    initHumanizeThresholds() {
        const CP = [
            ['humanize_cp_second', 40], ['humanize_cp_third', 75], ['humanize_cp_fourth', 110],
            ['humanize_cp_inaccuracy', 230], ['humanize_cp_mistake', 377], ['humanize_cp_blunder', 600],
        ];
        const rows = CP.map(([key, dflt]) => ({
            key, dflt,
            range: document.getElementById(`${key}_range`),
            num: document.getElementById(`${key}_num`),
            readout: document.getElementById(`${key}_readout`),
        }));
        if (!rows.every(r => r.num && r.readout)) return; // stale cached page html (range is optional)

        // short form: this sits in the mix table's Accuracy column, not on its own line
        const readoutText = (loss) => {
            const {acc, drop} = moveQuality(loss);
            return `${Math.round(acc)}% acc · ${Math.round(drop)}% drop`;
        };
        const paint = (el) =>
            el?.style.setProperty('--fill', ((el.value - el.min) / (el.max - el.min) * 100) + '%');
        const load = (key, dflt) => {
            try { const v = JSON.parse(MephistoConfig.get(key)); return (v != null && isFinite(+v)) ? +v : dflt; }
            catch (e) { return dflt; }
        };
        const set = (row, val, persist = true) => {
            val = Math.min(800, Math.max(0, Math.round(+val / 5) * 5 || 0)); // snap to the 5cp step
            if (row.range) row.range.value = val;
            row.num.value = val;
            row.readout.textContent = readoutText(val);
            paint(row.range);
            if (persist) MephistoConfig.set(row.key, val);
            this.updateHumanizeSummary(); // a band moved, so the weighted accuracy moved
        };
        rows.forEach(r => {
            set(r, load(r.key, r.dflt), false);
            r.range?.addEventListener('input', () => set(r, r.range.value));
            r.num.addEventListener('change', () => set(r, r.num.value));
        });
        // The mix populates BEFORE this does, so its first summary was computed against empty cp
        // fields. This is the pass that gets it right on page open.
        this.updateHumanizeSummary();
    }

    // Copy Diagnostics from the settings page. The same worker report the hotkey fetches, minus the
    // panel-only context (what is on screen, why the last move did not happen) -- this page has no
    // panel to ask. The bulk of a report is the worker's trace ring either way.
    initCopyDiagnostics() {
        const btn = document.getElementById('copy_diag_btn');
        const status = document.getElementById('copy_diag_status');
        if (!btn || !status) return; // stale cached page html
        btn.addEventListener('click', () => {
            status.textContent = 'Collecting…';
            chrome.runtime.sendMessage({diagnostics: {site: 'settings page'}}, async (res) => {
                if (chrome.runtime.lastError || !res || res.error) {
                    status.textContent = `Could not collect diagnostics: ` +
                        `${chrome.runtime.lastError?.message || res?.error || 'no answer'}`;
                    return;
                }
                try {
                    await navigator.clipboard.writeText(res.report);
                    status.textContent = `Copied — ${res.report.split('\n').length} lines. Paste it into your report.`;
                } catch (e) {
                    status.textContent = `Collected, but the clipboard refused: ${e.message || e}`;
                }
            });
        });
    }

    // Self-update. NOT a FormElement, and no config key at all: the CHROME PERMISSION is the
    // setting. A stored flag beside it could only ever disagree with it -- revoke the host in
    // chrome://extensions and a stored `true` would still render as On while every download failed.
    // So the checkbox is drawn from chrome.permissions.contains() and writes nothing.
    initUpdater() {
        const cb = document.getElementById('auto_update_checkbox');
        const checkBtn = document.getElementById('update_check_btn');
        const folderBtn = document.getElementById('update_folder_btn');
        const installBtn = document.getElementById('update_install_btn');
        const rollbackBtn = document.getElementById('update_rollback_btn');
        const resumeBtn = document.getElementById('update_resume_btn');
        const status = document.getElementById('update_status');
        if (!cb || !checkBtn || !folderBtn || !installBtn || !status) return; // stale cached page html

        const say = (t) => { status.textContent = t; };
        const buttons = [checkBtn, folderBtn, installBtn, rollbackBtn, resumeBtn].filter(Boolean);
        const current = chrome.runtime.getManifest().version;
        let latest = null; // last release seen, so Install can name it

        const render = async () => {
            // The SETTING is what the user chose; the permission is only a capability. Reading the
            // permission back as the setting is what made the switch impossible to turn off.
            const on = await MephistoUpdater.enabled();
            const granted = on && await MephistoUpdater.hasPermission();
            cb.checked = on;
            buttons.forEach(b => b.disabled = !granted);
            if (!on) return say('Off — Mephisto downloads nothing and asks GitHub for nothing extra.');
            if (!granted) {
                return say('On, but Chrome is no longer holding the download permission — ' +
                    'switch this off and on again to ask for it.');
            }
            const dir = await MephistoUpdater.savedFolder();
            if (!dir) return say(`On — you have v${current}. Choose the extension folder to finish setting this up.`);
            say(`On — you have v${current}, and updates go into "${dir.name}".`);
            // Both of these exist only as a consequence of a previous install, so they are hidden
            // until there is actually something to undo or finish -- a permanently greyed-out
            // button teaches you nothing.
            const [back, pending] = await Promise.all([
                MephistoUpdater.rollbackInfo().catch(() => null),
                MephistoUpdater.pendingInstall().catch(() => null),
            ]);
            rollbackBtn?.classList.toggle('hidden', !back);
            if (back && rollbackBtn) rollbackBtn.textContent = `Roll Back to v${back.version}`;
            resumeBtn?.classList.toggle('hidden', !pending);
            if (pending) return say(`An update to v${pending.version} was interrupted before it finished. ` +
                `Press Finish Interrupted Update — the files are already downloaded.`);
            report(await MephistoUpdater.check().catch(() => null), dir);
        };

        // One place that turns a release into a sentence, so the automatic check on page open and
        // the Check button cannot word the same state two different ways.
        const report = (rel, dir) => {
            if (!rel || !rel.latest) return say(`On — you have v${current}. Could not reach GitHub just now.`);
            latest = rel;
            if (!rel.newer) return say(`Up to date — v${current} is the newest release.`);
            if (!dir) return say(`Update available — v${rel.latest}. Choose the extension folder, then press Install Update.`);
            if (!rel.asset) return say(`Update available — v${rel.latest}, but that release has no update archive. Download the full zip.`);
            say(`Update available — v${rel.latest} (${(rel.size / 1048576).toFixed(1)} MB). Press Install Update.`);
        };

        // Turning it ON is the permission prompt, and a refusal has to snap the switch back --
        // otherwise the page claims a permission Chrome did not give.
        cb.addEventListener('change', async () => {
            if (cb.checked) {
                const granted = await MephistoUpdater.requestPermission().catch(() => false);
                await MephistoUpdater.setEnabled(granted); // refusing the prompt leaves it off
                if (!granted) say('Chrome did not grant the download permission, so this stays off.');
            } else {
                // ORDER MATTERS. Record the intent FIRST, then try to hand the permission back:
                // chrome.permissions.remove can answer false and keep it (granting a path-scoped
                // pattern can widen it to the whole origin, which the narrow pattern then cannot
                // remove). Off has to mean off whatever Chrome decides to keep.
                await MephistoUpdater.setEnabled(false);
                await MephistoUpdater.dropPermission().catch(() => {});
            }
            render();
        });

        checkBtn.addEventListener('click', async () => {
            say('Checking…');
            buttons.forEach(b => b.disabled = true);
            const rel = await MephistoUpdater.check({force: true}).catch(() => null);
            report(rel, await MephistoUpdater.savedFolder());
            buttons.forEach(b => b.disabled = false);
        });

        folderBtn.addEventListener('click', async () => {
            try {
                const picked = await MephistoUpdater.pickFolder();
                say(`Folder set — "${picked.name}", holding v${picked.version}.`);
                report(latest || await MephistoUpdater.check().catch(() => null), {name: picked.name});
            } catch (e) {
                // AbortError is the user closing the picker, which is not a failure and needs no line
                if (e?.name !== 'AbortError') say(`Could not use that folder: ${e.message || e}`);
            }
        });

        const runInstall = async () => {
            buttons.forEach(b => b.disabled = true);
            try {
                const res = await MephistoUpdater.install(say);
                if (res.already) {
                    say(`Up to date — v${res.version} is the newest release.`);
                } else {
                    // The reload tears this page down, so the line has to be on screen first. It
                    // also orphans the content script in every open game tab, hence the reminder.
                    // Leave a note for the panel to show once, so you find out WHAT changed without
                    // going to look for the release. Cleared by the panel after it is shown.
                    await chrome.storage.local.set({mephisto_whats_new: {
                        version: res.installed, headline: res.headline || '', at: Date.now(),
                    }});
                    const kept = res.backedUp ? ` Roll back to v${res.from} from this page if it misbehaves.` : '';
                    say(`Installed v${res.installed} over v${res.from} — ${res.files} files.${kept} ` +
                        `Reloading the extension; reload your game tabs.`);
                    setTimeout(() => chrome.runtime.reload(), 1500);
                    return; // leave the buttons disabled: this page is about to go away
                }
            } catch (e) {
                say(`Update failed, and nothing was changed: ${e.message || e}`);
            }
            buttons.forEach(b => b.disabled = false);
        };
        installBtn.addEventListener('click', runInstall);

        rollbackBtn?.addEventListener('click', async () => {
            buttons.forEach(b => b.disabled = true);
            try {
                const res = await MephistoUpdater.rollback(say);
                say(`Rolled back to v${res.version} — ${res.files} files restored` +
                    `${res.removed ? `, ${res.removed} removed` : ''}. Reloading the extension; reload your game tabs.`);
                setTimeout(() => chrome.runtime.reload(), 1500);
                return; // this page is about to go away
            } catch (e) {
                say(`Roll back failed, and nothing was changed: ${e.message || e}`);
            }
            buttons.forEach(b => b.disabled = false);
        });

        resumeBtn?.addEventListener('click', async () => {
            buttons.forEach(b => b.disabled = true);
            try {
                const res = await MephistoUpdater.finishStaged(say);
                say(`Finished the update to v${res.version} — ${res.files} files. ` +
                    `Reloading the extension; reload your game tabs.`);
                setTimeout(() => chrome.runtime.reload(), 1500);
                return;
            } catch (e) {
                say(`Could not finish the update, and nothing was changed: ${e.message || e}`);
            }
            buttons.forEach(b => b.disabled = false);
        });

        // The panel's "click to install" hands off to here -- the worker raises a flag and opens
        // this page, and the install starts on its own. The flag is cleared BEFORE anything runs, so
        // reloading this page afterwards never re-triggers an update.
        const autostart = async () => {
            const {mephisto_autostart_update: wanted} =
                await chrome.storage.local.get('mephisto_autostart_update');
            if (!wanted) return;
            await chrome.storage.local.remove('mephisto_autostart_update');
            document.getElementById('updates')?.scrollIntoView({block: 'center'});
            if (await MephistoUpdater.isReady()) runInstall();
        };

        render().then(autostart);
    }

    // Puzzle database import. NOT a FormElement: what is stored is an IndexedDB of six million
    // positions, not a config value, so it has nothing to push, pull or export. The import runs HERE
    // rather than in the offscreen document because a File cannot survive chrome.runtime.sendMessage
    // (it is JSON-serialized, not structure-cloned) -- and this page is extension-origin, so it
    // writes the very same database the service worker reads.
    initPuzzleDb() {
        const btn = document.getElementById('puzzle_db_btn');
        const clearBtn = document.getElementById('puzzle_db_clear_btn');
        const file = document.getElementById('puzzle_db_file');
        const status = document.getElementById('puzzle_db_status');
        if (!btn || !file || !status) return; // stale cached page html
        const n = (x) => x.toLocaleString();
        const idle = async () => {
            try {
                // Reported per database, because they are separate stores and only the one for the
                // site you are on is ever consulted. "6.6M positions" hid the fact that none of them
                // were chess.com's.
                const c = await PuzzleDB.count();
                const parts = [];
                if (c.li) parts.push(`${n(c.li)} Lichess`);
                if (c.cc) parts.push(`${n(c.cc)} Chess.com`);
                status.textContent = parts.length
                    ? `${parts.join(' · ')} puzzle positions loaded. Puzzle Mode plays the known solution.`
                    : 'No puzzle database loaded — Puzzle Mode uses the engine.';
            } catch (e) {
                status.textContent = `Could not read the database: ${e}`;
            }
        };
        idle();
        btn.addEventListener('click', () => file.click());
        clearBtn?.addEventListener('click', async () => {
            status.textContent = 'Removing…';
            try { await PuzzleDB.clear(); } catch (e) { /* reported by idle() */ }
            idle();
        });
        file.addEventListener('change', async () => {
            const f = file.files[0];
            file.value = ''; // re-picking the SAME file must fire 'change' again
            if (!f) return;
            // The published file is .zst and browsers have no zstd decoder (DecompressionStream does
            // gzip and deflate only), so say which one is wanted rather than failing at row 1 with a
            // parse error that reads like a corrupt download.
            if (/\.zst$/i.test(f.name)) {
                status.textContent = 'That is the compressed file. Decompress it first: ' +
                    'unzstd lichess_db_puzzle.csv.zst — then pick the .csv.';
                return;
            }
            btn.disabled = clearBtn.disabled = true;
            status.textContent = 'Reading… (this takes a few minutes; leave this page open)';
            try {
                const t0 = Date.now();
                // SAN -> UCI for the chess.com daily rows. Built here rather than inside
                // puzzle-db.js because that module also loads in the service worker, which has no
                // chess.js -- an import there simply skips those rows instead of failing.
                const sanToUci = (fen, sans) => {
                    try {
                        const g = new Chess('chess', fen);
                        const out = [];
                        for (const san of sans) {
                            const mv = g.move(san);
                            if (!mv) return null;
                            out.push(mv.from + mv.to + (mv.promotion || ''));
                        }
                        return out;
                    } catch (e) {
                        return null; // a SAN this position cannot explain -- skip the row
                    }
                };
                const res = await PuzzleDB.importCsv(f, ({rows, kept}) => {
                    const mins = (Date.now() - t0) / 60000;
                    status.textContent = `Importing… ${n(kept)} positions from ${n(rows)} puzzles ` +
                        `(${mins.toFixed(1)} min)`;
                }, {sanToUci});
                // COUNT, not `kept`. The key is the position, and two puzzles can be generated from
                // the same one, so the store holds slightly fewer records than rows read -- reporting
                // `kept` would claim a number the database does not contain.
                // Count the database this file actually went into, not the pair -- otherwise a
                // chess.com import reports the Lichess total sitting beside it and reads as though
                // it loaded ten times what it did.
                const stored = await PuzzleDB.count(res.site);
                const which = res.site === 'cc' ? 'Chess.com' : 'Lichess';
                status.textContent = `Done — ${n(stored)} ${which} puzzle positions loaded from ` +
                    `${n(res.rows)} puzzles. Puzzle Mode will play the known solution.`;
            } catch (e) {
                status.textContent = `Import failed: ${e}`;
            } finally {
                btn.disabled = clearBtn.disabled = false;
            }
        });
    }
}

define({
    title: 'General Settings',
    page: new GeneralSettings()
});
