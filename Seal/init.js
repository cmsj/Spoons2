// Seal — ported from the v1 Seal Spoon (an Alfred-like launcher).
//
// v1 loaded plugins by name (apps, vpn, screencapture, calc, useractions,
// pasteboard, filesearch) onto a shared toolbar-equipped chooser. v2's hs.chooser has no
// toolbar API, so the toolbar's one feature (a "hide toolbar" button) is dropped — see the
// migration report. Everything else is rebuilt on a single hs.chooser using a keyword-prefixed
// query, matching v1's per-plugin keyword dispatch:
//
//   <nothing>       -> apps (default fallback) or a live calculator result
//   pb <text>       -> pasteboard history
//   file <text>     -> Spotlight file search
//   vpn             -> list/toggle VPN services
//   cap             -> screenshot actions
//   <useraction>    -> keyword configured via configure({ useractions })

let chooser = null
let started = false
let hotkey = null

let appCache = []           // [{ text, bundleID }]
let pasteboardHistory = []  // [string, ...] most recent first
let pasteboardHistorySize = 4000
let pasteboardWatcherStarted = false

let vpnServices = []        // [string]
let vpnFetchInFlight = false

let fileSearchQuery = null
let fileSearchResults = []  // [{ text, path }]

let userActions = {}        // name -> { url, keyword }

// ---------------------------------------------------------------------------
// Plugin: apps
// ---------------------------------------------------------------------------

function refreshAppCache() {
    const q = hs.spotlight.search(
        "kMDItemContentType == 'com.apple.application-bundle'",
        (event) => {
            if (event !== "didFinish") return
            appCache = q.results().map((item) => ({
                text: item.valueForAttribute(hs.spotlight.attribute.displayName),
                bundleID: item.valueForAttribute(hs.spotlight.attribute.bundleIdentifier),
            })).filter((a) => a.text && a.bundleID)
            q.stop()
            console.log(`[Seal] cached ${appCache.length} apps`)
        }
    )
    q.setScopes(hs.spotlight.scope.applications)
}

function appsQuery(text) {
    const needle = text.toLowerCase()
    return appCache
        .filter((a) => !needle || a.text.toLowerCase().includes(needle))
        .slice(0, 9)
        .map((a) => ({ text: a.text, subText: a.bundleID, pluginId: "apps", bundleID: a.bundleID }))
}

function appsSelect(item) {
    hs.application.launchOrFocus(item.bundleID)
}

// ---------------------------------------------------------------------------
// Plugin: calc — small safe arithmetic evaluator (no eval on user input)
// ---------------------------------------------------------------------------

function evaluateExpression(text) {
    if (!/^[\d\s+\-*/().]+$/.test(text) || !/\d/.test(text)) return null

    let pos = 0
    const peek = () => text[pos]
    const isDigit = (c) => c >= "0" && c <= "9"

    function parseNumber() {
        let start = pos
        while (pos < text.length && (isDigit(peek()) || peek() === ".")) pos++
        if (pos === start) return null
        return parseFloat(text.slice(start, pos))
    }

    function parseFactor() {
        while (peek() === " ") pos++
        if (peek() === "(") {
            pos++
            const v = parseExpr()
            while (peek() === " ") pos++
            if (peek() !== ")") throw new Error("expected )")
            pos++
            return v
        }
        if (peek() === "-") { pos++; return -parseFactor() }
        if (peek() === "+") { pos++; return parseFactor() }
        const n = parseNumber()
        if (n === null) throw new Error("expected number")
        return n
    }

    function parseTerm() {
        let v = parseFactor()
        for (;;) {
            while (peek() === " ") pos++
            if (peek() === "*") { pos++; v *= parseFactor() }
            else if (peek() === "/") { pos++; v /= parseFactor() }
            else break
        }
        return v
    }

    function parseExpr() {
        let v = parseTerm()
        for (;;) {
            while (peek() === " ") pos++
            if (peek() === "+") { pos++; v += parseTerm() }
            else if (peek() === "-") { pos++; v -= parseTerm() }
            else break
        }
        return v
    }

    try {
        const result = parseExpr()
        while (peek() === " ") pos++
        if (pos !== text.length) return null
        return result
    } catch {
        return null
    }
}

function calcQuery(text) {
    const result = evaluateExpression(text)
    if (result === null) return []
    return [{ text: String(result), subText: `${text} =`, pluginId: "calc", value: String(result) }]
}

function calcSelect(item) {
    hs.pasteboard.writeString(item.value)
}

// ---------------------------------------------------------------------------
// Plugin: useractions — keyword -> URL template with ${query} substitution
// ---------------------------------------------------------------------------

function userActionsQuery(keyword, text) {
    const entry = Object.entries(userActions).find(([, v]) => v.keyword === keyword)
    if (!entry) return []
    const [name, action] = entry
    const url = action.url.replace("${query}", encodeURIComponent(text))
    return [{ text: `${name}: ${text}`, subText: url, pluginId: "useraction", url, valid: text.length > 0 }]
}

function userActionsSelect(item) {
    hs.urlevent.openURL(item.url)
}

// ---------------------------------------------------------------------------
// Plugin: pasteboard history
// ---------------------------------------------------------------------------

function startPasteboardWatcher() {
    if (pasteboardWatcherStarted) return
    pasteboardWatcherStarted = true
    hs.pasteboard.on('change', () => {
        const value = hs.pasteboard.readString()
        if (!value) return
        pasteboardHistory = pasteboardHistory.filter((v) => v !== value)
        pasteboardHistory.unshift(value)
        if (pasteboardHistory.length > pasteboardHistorySize) {
            pasteboardHistory.length = pasteboardHistorySize
        }
    })
}

function pasteboardQuery(text) {
    const needle = text.toLowerCase()
    return pasteboardHistory
        .filter((v) => !needle || v.toLowerCase().includes(needle))
        .slice(0, 20)
        .map((v) => ({
            text: v.length > 80 ? v.slice(0, 80) + "…" : v,
            pluginId: "pasteboard",
            value: v,
        }))
}

function pasteboardSelect(item) {
    hs.pasteboard.writeString(item.value)
}

// ---------------------------------------------------------------------------
// Plugin: filesearch — live Spotlight query, debounced from onQueryChange
// ---------------------------------------------------------------------------

function runFileSearch(text) {
    if (fileSearchQuery) { fileSearchQuery.stop(); fileSearchQuery = null }
    if (!text) { fileSearchResults = []; return }

    const escaped = text.replace(/"/g, '\\"')
    fileSearchQuery = hs.spotlight.search(
        `kMDItemFSName CONTAINS[c] "${escaped}"`,
        (event) => {
            if (event !== "didFinish") return
            fileSearchResults = fileSearchQuery.results().slice(0, 200).map((item) => ({
                text: item.valueForAttribute(hs.spotlight.attribute.fsName),
                subText: item.valueForAttribute(hs.spotlight.attribute.path),
                path: item.valueForAttribute(hs.spotlight.attribute.path),
            }))
            fileSearchQuery.stop()
            if (chooser) chooser.refreshChoices()
        }
    )
    fileSearchQuery.setScopes(hs.spotlight.scope.home)
}

function fileSearchQueryRows(text) {
    return fileSearchResults
        .slice(0, 9)
        .map((f) => ({ text: f.text, subText: f.subText, pluginId: "filesearch", path: f.path }))
}

function fileSearchSelect(item) {
    hs.task.create("/usr/bin/open", [item.path]).start()
}

// ---------------------------------------------------------------------------
// Plugin: screencapture
// ---------------------------------------------------------------------------

function screencaptureQuery() {
    return [
        { text: "Screenshot: selection to clipboard", pluginId: "screencapture", args: ["-i", "-c"] },
        { text: "Screenshot: full screen to clipboard", pluginId: "screencapture", args: ["-c"] },
    ]
}

function screencaptureSelect(item) {
    hs.task.create("/usr/sbin/screencapture", item.args).start()
}

// ---------------------------------------------------------------------------
// Plugin: vpn — cached from `scutil --nc list`, refreshed on demand
// ---------------------------------------------------------------------------

function refreshVpnServices() {
    if (vpnFetchInFlight) return
    vpnFetchInFlight = true
    let output = ""
    hs.task.create("/usr/sbin/scutil", ["--nc", "list"], () => {
        vpnFetchInFlight = false
        const names = []
        for (const line of output.split("\n")) {
            const match = line.match(/"([^"]+)"/)
            if (match) names.push(match[1])
        }
        vpnServices = names
        if (chooser) chooser.refreshChoices()
    }, null, (_stream, data) => { output += data }).start()
}

function vpnQuery() {
    if (vpnServices.length === 0) refreshVpnServices()
    return vpnServices.map((name) => ({ text: `Connect: ${name}`, pluginId: "vpn", action: "start", name }))
}

function vpnSelect(item) {
    hs.task.create("/usr/sbin/scutil", ["--nc", item.action, item.name]).start()
}

// ---------------------------------------------------------------------------
// Plugin registry + dispatch
// ---------------------------------------------------------------------------

const plugins = {
    apps: { select: appsSelect },
    calc: { select: calcSelect },
    useraction: { select: userActionsSelect },
    pasteboard: { select: pasteboardSelect },
    filesearch: { select: fileSearchSelect },
    screencapture: { select: screencaptureSelect },
    vpn: { select: vpnSelect },
}

function computeRows(query) {
    const trimmed = query.trim()
    const spaceIndex = trimmed.indexOf(" ")
    const keyword = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)
    const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1)

    if (keyword === "pb") return pasteboardQuery(rest)
    if (keyword === "file") { runFileSearch(rest); return fileSearchQueryRows(rest) }
    if (keyword === "vpn" && rest === "") return vpnQuery()
    if (keyword === "cap" && rest === "") return screencaptureQuery()

    const userActionRows = userActionsQuery(keyword, rest)
    if (userActionRows.length > 0) return userActionRows

    // Default: calculator result (if it parses) plus app search
    return [...calcQuery(trimmed), ...appsQuery(trimmed)]
}

function onSelect(item) {
    if (!item) return
    const plugin = plugins[item.pluginId]
    if (plugin) plugin.select(item)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function configure(options) {
    if (options.useractions) userActions = options.useractions
    if (options.pasteboardHistorySize) pasteboardHistorySize = options.pasteboardHistorySize
    return module.exports
}

function ensureChooser() {
    if (chooser) return
    chooser = hs.chooser.create()
    chooser.placeholder = "Seal"
    chooser.setChoices((query) => computeRows(query))
    chooser.onSelect = onSelect
    chooser.onQueryChange = () => {
        hs.timer.doAfter(0.05, () => { if (chooser) chooser.refreshChoices() })
    }
}

function show() {
    ensureChooser()
    chooser.query = ""
    chooser.show()
}

function toggle(prefix) {
    ensureChooser()
    if (chooser.isVisible) {
        chooser.hide()
        return
    }
    chooser.query = prefix ? `${prefix} ` : ""
    chooser.show()
}

function start() {
    if (started) return module.exports
    started = true
    ensureChooser()
    refreshAppCache()
    startPasteboardWatcher()
    console.log("[Seal] started")
    return module.exports
}

function stop() {
    if (!started) return module.exports
    started = false
    if (chooser) { chooser.hide() }
    console.log("[Seal] stopped")
    return module.exports
}

function bindHotkeys(mapping) {
    if (mapping.show) {
        hotkey = hs.hotkey.bind(mapping.show[0], mapping.show[1], () => show(), null)
    }
}

module.exports = { configure, start, stop, show, toggle, bindHotkeys }
