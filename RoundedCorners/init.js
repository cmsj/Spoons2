// RoundedCorners — ported from the v1 Spoon of the same name, using hs.canvas.
//
// v1 drew a true rounded-rect mask using hs.canvas path clipping: a small canvas sits
// over each physical screen corner, with a circle punching a hole out of an opaque
// rectangle via the build/clip/reversePath technique (nonZero winding cancellation).
// hs.ui (the SwiftUI-based v2 UI module) has no path/clip API, so an earlier port of
// this Spoon had to approximate the effect with a plain circle straddling each corner —
// visually similar, but not a pixel-accurate rounded corner, and unable to click through.
//
// hs.canvas (added to v2 specifically to close this kind of gap) supports the same
// build/clip/reversePath pipeline v1 used, so this port restores the original technique
// exactly: the circle is centered on the box's INNER corner (the corner facing the
// screen's center, opposite the physical corner) with radius equal to the box size —
// everything within that circle is punched transparent, leaving only a thin curved
// sliver over the true screen corner still filled black.
const RADIUS = 12
let cornerCanvases = []
let screenWatcherSet = false

// hs.screen coordinates are flipped (0,0 = top-left of the primary screen, y down), but
// hs.canvas.create() takes raw AppKit coordinates (0,0 = bottom-left, y up) — convert here.
function flippedToAppKit(x, y, w, h) {
    const primaryHeight = hs.screen.primary().fullFrame.h
    return { x, y: primaryHeight - y - h, w, h }
}

// `center` is the RADIUS x RADIUS box's INNER corner (opposite the physical screen
// corner) — the punch-out circle sweeps outward from there, leaving a black sliver only
// where the circle doesn't reach: the box's outer, physical-corner triangle.
//
// Note the y-axis mismatch this has to account for: the box's on-screen *position*
// (x/y passed to create()) is unflipped AppKit coordinates (y=0 at the bottom of the
// screen), but element *content* inside the canvas -- these frame/center coordinates --
// is drawn through SwiftUI's Canvas, which is natively y-down (0,0 at the box's own
// top-left, y increasing downward). So "inner corner" below is expressed in that
// content-local, y-down sense, not the same sense as the box's screen position.
function makeCorner(boxX, boxY, center) {
    return hs.canvas.create({ x: boxX, y: boxY, w: RADIUS, h: RADIUS })
        .appendElements([
            { action: "build", type: "rectangle" },
            { action: "clip", type: "circle", center, radius: RADIUS, reversePath: true },
            { action: "fill", type: "rectangle", frame: { x: 0, y: 0, w: RADIUS, h: RADIUS }, fillColor: { red: 1, green: 1, blue: 1, alpha: 1 } },
            { type: "resetClip" },
        ])
        // hs.canvas.windowLevels exposes raw numeric levels (not opaque names), so this
        // can sit one level above the screen saver exactly like v1 did.
        .levelValue(hs.canvas.windowLevels.screenSaver + 1)
        .behavior("canJoinAllSpaces")
        .behavior("stationary")
        // A capability the earlier hs.ui-based port didn't have: full click pass-through,
        // so these purely decorative overlays never intercept clicks meant for whatever
        // is underneath them.
        .ignoreMouseEvents(true)
        .show()
}

function render() {
    cornerCanvases.forEach((c) => c.destroy())
    cornerCanvases = []

    for (const screen of hs.screen.all()) {
        const f = flippedToAppKit(screen.fullFrame.x, screen.fullFrame.y, screen.fullFrame.w, screen.fullFrame.h)

        cornerCanvases.push(makeCorner(f.x, f.y + f.h - RADIUS, { x: RADIUS, y: RADIUS }))  // top-left
        cornerCanvases.push(makeCorner(f.x + f.w - RADIUS, f.y + f.h - RADIUS, { x: 0, y: RADIUS }))  // top-right
        cornerCanvases.push(makeCorner(f.x, f.y, { x: RADIUS, y: 0 }))                      // bottom-left
        cornerCanvases.push(makeCorner(f.x + f.w - RADIUS, f.y, { x: 0, y: 0 }))            // bottom-right
    }
}

function start() {
    render()
    if (!screenWatcherSet) {
        hs.screen.on('change', () => render())
        screenWatcherSet = true
    }
    console.log("[RoundedCorners] started")
    return module.exports
}

function stop() {
    cornerCanvases.forEach((c) => c.destroy())
    cornerCanvases = []
    console.log("[RoundedCorners] stopped")
    return module.exports
}

module.exports = { start, stop, render }
