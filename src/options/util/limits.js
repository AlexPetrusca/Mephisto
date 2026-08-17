// WARN WHEN A NUMBER CANNOT WORK. Threads above the machine's cores make the engine SLOWER -- the
// searchers fight each other for the same cores -- and hash beyond memory thrashes to disk. Both are
// knowable, so a field that quietly makes things worse gets one amber sentence instead.
//
// The honesty caveat, written down so nobody re-derives it: navigator.deviceMemory is CAPPED AT 8 by
// spec. A machine reporting 8 may have 64GB, so the hash warning only fires when the report is UNDER
// the cap -- there it is a real ceiling. Cores are reported truthfully and always checked.
export function threadsWarning(n) {
    const cores = navigator.hardwareConcurrency || 0;
    if (!cores || !(n > cores)) return '';
    return `This machine has ${cores} cores - ${n} threads will fight each other and search slower, not faster.`;
}

export function hashWarning(mb) {
    const gb = navigator.deviceMemory || 0;
    if (!gb || gb >= 8) return '';            // at the spec cap the real memory is unknowable
    if (!(mb > gb * 1024 / 2)) return '';     // half of a small machine is already generous for hash
    return `This machine reports ${gb}GB of memory - a ${mb}MB hash will push it into swapping.`;
}

// One line per page: both checks, joined, into a .limit-warn element that hides itself when empty.
export function refreshLimitWarnings(el, threads, hashMb) {
    if (!el) return;
    el.textContent = [threadsWarning(+threads || 0), hashWarning(+hashMb || 0)].filter(Boolean).join(' ');
}
