// FocusBorder — draws a border around the focused window, if there is one.
//
// An hs.windowfilter decides which windows deserve a border (visible, non-fullscreen windows in
// the current Space, minus the default filter's transient apps like Spotlight) and tells us when
// anything relevant happens to them. A single click-through hs.canvas is moved over whichever
// allowed window is focused, and hidden when none is.
//
// Usage:
//   hs.spoons.load("FocusBorder").start()
//   // or, configured:
//   hs.spoons.use("FocusBorder", { config: { color: "#FF8800", width: 6 }, start: true })

const obj = {
    /// Border colour: a hex string or {red, green, blue, alpha}
    color: { red: 0, green: 0.85, blue: 0.2, alpha: 1 },
    /// Border thickness, in points
    width: 4,
    /// Corner radius of the window's edge the border follows, in points (0 for square corners)
    radius: 16,
}

// Events after which the focused window, or where it is, may have changed
const EVENTS = [
    "windowFocused", "windowUnfocused", "windowMoved",
    "windowMinimized", "windowHidden", "windowDestroyed", "windowRejected",
    "windowNotOnScreen", "windowOnScreen", "windowFullscreened", "windowUnfullscreened",
]

let filter = null
let canvas = null
const listener = () => update()

function borderFrame(winFrame) {
    // The canvas sits just outside the window, so the border doesn't cover its content
    const w = obj.width
    return { x: winFrame.x - w, y: winFrame.y - w, w: winFrame.w + 2 * w, h: winFrame.h + 2 * w }
}

function borderElement(size) {
    // Stroke a path centred in the band between the window's edge and the canvas's edge
    const w = obj.width
    return {
        type: "rectangle",
        action: "stroke",
        strokeColor: obj.color,
        strokeWidth: w,
        frame: { x: w / 2, y: w / 2, w: size.w - w, h: size.h - w },
        roundedRectRadii: obj.radius > 0 ? obj.radius + w / 2 : 0,
    }
}

function update() {
    if (!filter || !canvas) return

    const focused = hs.window.focusedWindow()
    // hs.windowfilter never tracks Hammerspoon's own windows (Console, canvases, etc.), so it never
    // reports them moving. Skip them, or the border would be left behind when one is dragged.
    const isOurs = focused && focused.pid === hs.appinfo.pid
    const win = focused && !isOurs && filter.isWindowAllowed(focused) ? focused : null
    draw(win ? win.frame : null)
}

// Puts the border around `winFrame`, or hides it if that's null
function draw(winFrame) {
    if (!canvas) return
    if (!winFrame) {
        if (canvas.isShowing()) canvas.hide(0)
        return
    }

    const frame = borderFrame(winFrame)
    canvas.setFrame(frame).replaceElements([borderElement(frame)])
    if (!canvas.isShowing()) canvas.show(0)
}

obj.start = function() {
    if (filter) return obj

    filter = hs.windowfilter.create().setOverrideRule({ visible: true, currentSpace: true, fullscreen: false })
    canvas = hs.canvas.create({ x: 0, y: 0, w: 1, h: 1 })
        .level("floating")
        .behavior("canJoinAllSpaces")
        .behavior("transient")
        .ignoreMouseEvents(true)

    for (const event of EVENTS) filter.on(event, listener)
    update()
    return obj
}

obj.stop = function() {
    if (filter) {
        for (const event of EVENTS) filter.off(event, listener)
        filter = null
    }
    if (canvas) {
        canvas.destroy(0)
        canvas = null
    }
    return obj
}

/// Redraws the border, e.g. after changing `color`, `width` or `radius`
obj.refresh = function() {
    update()
    return obj
}

module.exports = obj
