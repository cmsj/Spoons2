// Statuslets — small coloured status dots in the bottom-right corner of the primary screen,
// drawn with hs.canvas. Ported from the v1 statuslets.lua config.
//
// Each statuslet is a label and a dot, coloured by a check you supply: either a command (exit
// code 0 is OK, anything else is a failure) or a function. They're laid out in columns so the
// canvas is never taller than the Dock, and it shows on every Space except full-screen ones.
//
// Settings (set them directly, or with hs.spoons.use()'s config option, before start()):
//   statuslets      Array of statuslets (see below). Default: []
//   interval        Default seconds between checks, for statuslets without their own. Default: 300
//   colors          Colours for the `ok`, `fail` and `pending` states (pending is shown until a
//                   statuslet's first check finishes). Any colour hs.canvas accepts.
//   textColor       Label colour. Default: "#FFFFFF"
//   backgroundColor Colour of a rounded backdrop behind the statuslets, or null for none. Default: null
//   textSize        Label font size; shrunk if a single row wouldn't fit beside the Dock. Default: 12
//   dotSize         Diameter of each dot. Default: 10
//   padding         Space around the statuslets, inside the canvas. Default: 4
//   fallbackHeight  Maximum height when the Dock reserves no space (it's auto-hidden). Default: 48
//   level           Window level, a name from hs.canvas.windowLevels. Default: "floating"
//
// A statuslet is an object with:
//   name      The label shown next to its dot
//   interval  Seconds between checks. Default: the Spoon's `interval`
// and either:
//   command   The full path of an executable to run; exit code 0 colours the dot `ok`, any
//             other exit code `fail`
//   args      An array of arguments for `command`, or a function returning one, called before
//             each run (for arguments that change, like today's date)
// or:
//   check     A function returning (or returning a Promise of) the dot's state: true for `ok`,
//             false for `fail`, the name of one of `colors`, or any colour hs.canvas accepts.
//             A thrown error or rejected Promise colours the dot `fail`.

const ROW_GAP = 4
const LABEL_GAP = 4
const COLUMN_GAP = 10
const MIN_TEXT_SIZE = 6
// An auto-hidden Dock reserves nothing (or a few points) of the screen, so a thinner reserved
// edge than this is taken to mean there's no Dock to measure.
const MIN_DOCK_THICKNESS = 20
// Resizing the Dock changes the screen's visible frame without firing hs.screen's "change"
// event, so the layout is also checked on a timer.
const LAYOUT_CHECK_INTERVAL = 30

let canvas = null
let entries = []      // { spec, color, timer, dotIndex }
let layoutKey = null
let layoutTimer = null

const statuslets = module.exports = {
    statuslets: [],
    interval: 300,
    colors: { ok: "#28C940", fail: "#FF3B30", pending: "#FF9500" },
    textColor: "#FFFFFF",
    backgroundColor: null,
    textSize: 12,
    dotSize: 10,
    padding: 4,
    fallbackHeight: 48,
    level: "floating",

    start, stop, update, render
}

function label(entry) {
    return `${entry.spec.name}:`
}

function resolveColor(result) {
    const colors = statuslets.colors
    if (result === true) return colors.ok
    if (result === false || result == null) return colors.fail
    if (typeof result === "string" && colors[result]) return colors[result]
    return result
}

function setResult(entry, result) {
    if (!entries.includes(entry)) return   // stopped while the check was running
    entry.color = resolveColor(result)
    if (canvas && entry.dotIndex !== null) {
        canvas.setElementAttribute(entry.dotIndex, "fillColor", entry.color)
    }
}

function fail(entry, err) {
    console.error(`[Statuslets] ${entry.spec.name}: ${err && err.message ? err.message : err}`)
    setResult(entry, false)
}

function runCheck(entry) {
    const spec = entry.spec
    try {
        if (spec.command) {
            const args = typeof spec.args === "function" ? spec.args() : (spec.args || [])
            hs.task.create(spec.command, args, (exitCode) => setResult(entry, exitCode === 0), null, null).start()
        } else {
            Promise.resolve(spec.check()).then((result) => setResult(entry, result), (err) => fail(entry, err))
        }
    } catch (err) {
        fail(entry, err)
    }
}

// How far the Dock reaches into the screen, from whichever edge it's on
function dockThickness(screen) {
    const full = screen.fullFrame
    const visible = screen.frame
    const thickness = Math.max(
        (full.y + full.h) - (visible.y + visible.h),    // bottom
        visible.x - full.x,                             // left
        (full.x + full.w) - (visible.x + visible.w)     // right
    )
    return thickness >= MIN_DOCK_THICKNESS ? thickness : statuslets.fallbackHeight
}

// Picks the largest text size (up to `textSize`) at which at least one row fits in maxHeight,
// then as few columns as that allows, balancing the rows across them.
function computeLayout(maxHeight) {
    const s = statuslets
    for (let textSize = s.textSize; ; textSize--) {
        const labels = entries.map((entry) => canvas.minimumTextSize({ textSize }, label(entry)))
        const rowHeight = Math.ceil(Math.max(s.dotSize, ...labels.map((size) => size.h)))
        const maxRows = Math.floor((maxHeight - 2 * s.padding + ROW_GAP) / (rowHeight + ROW_GAP))
        if (maxRows >= 1 || textSize <= MIN_TEXT_SIZE) {
            const columns = Math.ceil(entries.length / Math.max(maxRows, 1))
            const rows = Math.ceil(entries.length / columns)
            return { textSize, labels, rowHeight, rows, columns }
        }
    }
}

function render() {
    if (!canvas) return
    const s = statuslets
    const screen = hs.screen.primary()
    const full = screen.fullFrame
    const maxHeight = dockThickness(screen)
    layoutKey = [full.x, full.y, full.w, full.h, maxHeight].join(",")

    entries.forEach((entry) => { entry.dotIndex = null })
    if (entries.length === 0) {
        canvas.replaceElements([])
        return
    }

    const { textSize, labels, rowHeight, rows, columns } = computeLayout(maxHeight)
    const elements = []
    if (s.backgroundColor) {
        elements.push({ type: "rectangle", action: "fill", fillColor: s.backgroundColor, roundedRectRadii: 6 })
    }

    // Fill each column top to bottom, with labels right-aligned against their dots
    let x = s.padding
    for (let column = 0; column < columns; column++) {
        const members = entries.slice(column * rows, (column + 1) * rows)
        const firstIndex = column * rows
        const labelWidth = Math.ceil(Math.max(...members.map((_, i) => labels[firstIndex + i].w)))
        members.forEach((entry, row) => {
            const y = s.padding + row * (rowHeight + ROW_GAP)
            const labelHeight = Math.ceil(labels[firstIndex + row].h)
            elements.push({
                type: "text", text: label(entry), textSize, textColor: s.textColor,
                textAlignment: "right", textLineBreak: "clip",
                frame: { x, y: y + (rowHeight - labelHeight) / 2, w: labelWidth, h: labelHeight },
            })
            entry.dotIndex = elements.length
            elements.push({
                type: "circle", action: "fill", fillColor: entry.color, radius: s.dotSize / 2,
                center: { x: x + labelWidth + LABEL_GAP + s.dotSize / 2, y: y + rowHeight / 2 },
            })
        })
        x += labelWidth + LABEL_GAP + s.dotSize + COLUMN_GAP
    }

    const w = x - COLUMN_GAP + s.padding
    const h = 2 * s.padding + rows * rowHeight + (rows - 1) * ROW_GAP

    // Bottom-right corner, centred vertically in a Dock-height band along the bottom edge
    canvas.setFrame({ x: full.x + full.w - w, y: full.y + full.h - h - Math.floor((maxHeight - h) / 2), w, h })
    canvas.replaceElements(elements)
}

function checkLayout() {
    const screen = hs.screen.primary()
    const full = screen.fullFrame
    if ([full.x, full.y, full.w, full.h, dockThickness(screen)].join(",") !== layoutKey) render()
}

// canJoinAllSpaces without fullScreenAuxiliary already keeps the canvas off full-screen Spaces,
// but hide it there explicitly too, in case macOS ever disagrees.
function showForSpace(space) {
    if (!canvas) return
    if (space && space.type === "fullscreen") {
        canvas.hide()
    } else {
        canvas.show()
    }
}

function onScreenChange() {
    render()
    showForSpace(hs.screen.primary().currentSpace)
}

function onSpaceChange(change) {
    if (!change || !change.screen || change.screen.uuid !== hs.screen.primary().uuid) return
    showForSpace(change.to)
}

// Runs every statuslet's check now, or just the one called `name`
function update(name) {
    entries.filter((entry) => name === undefined || entry.spec.name === name).forEach(runCheck)
    return statuslets
}

function start() {
    if (canvas) return statuslets

    entries = statuslets.statuslets
        .filter((spec) => {
            if (spec && spec.name && (spec.command || typeof spec.check === "function")) return true
            console.error(`[Statuslets] Ignoring a statuslet without a name, and a command or check: ${JSON.stringify(spec)}`)
            return false
        })
        .map((spec) => ({ spec, color: statuslets.colors.pending, timer: null, dotIndex: null }))

    canvas = hs.canvas.create({ x: 0, y: 0, w: 1, h: 1 })
        .level(statuslets.level)
        .behaviorList(["canJoinAllSpaces", "stationary", "ignoresCycle"])
        .ignoreMouseEvents(true)
    onScreenChange()

    hs.screen.on("change", onScreenChange)
    hs.screen.on("spaceChange", onSpaceChange)
    layoutTimer = hs.timer.doEvery(LAYOUT_CHECK_INTERVAL, checkLayout)

    for (const entry of entries) {
        entry.timer = hs.timer.doEvery(entry.spec.interval || statuslets.interval, () => runCheck(entry))
        runCheck(entry)
    }

    console.log("[Statuslets] started")
    return statuslets
}

function stop() {
    hs.screen.off("change", onScreenChange)
    hs.screen.off("spaceChange", onSpaceChange)
    if (layoutTimer) { layoutTimer.stop(); layoutTimer = null }
    entries.forEach((entry) => { if (entry.timer) entry.timer.stop() })
    entries = []
    if (canvas) { canvas.destroy(); canvas = null }
    layoutKey = null
    console.log("[Statuslets] stopped")
    return statuslets
}
