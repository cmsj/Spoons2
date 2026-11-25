// StreamDeckPlugin — connects your config to keys and dials in the Elgato Stream Deck app, through
// the "Hammerspoon 2" Stream Deck plugin.
//
// Unlike hs.streamdeck, which drives the hardware itself (so the Elgato app can't run at the same
// time), this works alongside the Elgato app: you place "Hammerspoon Key" and "Hammerspoon Dial"
// actions in your normal profiles, pages, folders and multi-actions, and give each one a name in its
// settings. Your config refers to them by that name. One name can be given to several keys (on
// different pages or devices, say), and they all show the same thing and send the same events.
//
// Install the Stream Deck plugin, then:
//
//   hs.spoons.use("StreamDeckPlugin", { source: "cmsj/Spoons2", start: true, fn: (deck) => {
//       const mute = deck.key("mute")
//       mute.on("down", () => toggleMute())
//       mute.setTitle("Live")
//       mute.setImage(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
//           <rect width="144" height="144" fill="#c00"/></svg>`)
//
//       const volume = deck.dial("volume")
//       volume.on("rotate", (ev) => adjustVolume(ev.ticks))
//       volume.setFeedback({ title: "Volume", value: "42%", indicator: 42 })
//   }})
//
// The plugin connects to this Spoon over a Unix domain socket (see SOCKET_PATH below), and
// reconnects within a second or so whenever the Spoon starts listening again, e.g. after a config
// reload. It remembers what each name should show, and puts it back whenever a key reappears (after
// a page or profile switch, say), so you only need to set things when they change. Anything set
// before the plugin connects, or while it's disconnected, is sent when it connects.
//
// Settings (set them directly, or with hs.spoons.use()'s config option, before start()):
//   debug         Log every message to and from the plugin to the Console, at Debug level. Default: false
//
// Methods:
//   start(), stop()   Start and stop listening for the plugin.
//   key(name), dial(name), control(name)
//                     The control for every key or dial with this name (all three return the same
//                     object; key() and dial() just read better). Its methods are below.
//   instance(id)      A control for one placed key or dial, by its id (see "Instances" below). What's
//                     set on it takes precedence over what's set on its name.
//   instances(name?)  The instances that are visible now, optionally only those with this name.
//   devices()         The Stream Deck devices the Elgato app knows about.
//   isConnected()     Whether the plugin is connected.
//   on(event, fn), off(event, fn?)
//                     Listen for events from every key and dial, and for the connection and devices
//                     coming and going (see "Events" below).
//
// A control's methods (each returns the control, so calls can be chained):
//   setImage(image)   An HSImage, SVG markup (a string starting "<svg"), a data: URL, or the absolute
//                     path of an image file. Keys are 144x144 pixels; larger HSImages are scaled down.
//                     null puts back the image chosen in the Elgato app.
//   setTitle(title)   The title drawn over the image. null puts back the title from the Elgato app.
//   setState(state)   Keys only: 0 or 1. The Elgato app lets users choose an image for each state.
//   setFeedback(obj)  Dials only: values for the items of the touch strip's layout, merged into
//                     what's already shown. The default layout ($B1) has `title`, `icon`, `value`
//                     and `indicator` (0-100). Images (an HSImage, SVG, data: URL, or a file path
//                     for `icon`) work as for setImage(). null clears everything set so far.
//   setLayout(layout) Dials only: one of Elgato's built-in layouts ("$X1", "$A0", "$A1", "$B1",
//                     "$B2", "$C1") or the path of a custom layout JSON file. null goes back to $B1.
//   setTriggerDescription({ rotate, push, touch, longTouch })
//                     Dials only: what the Elgato app says each gesture does.
//   showAlert(), showOk()
//                     Briefly show a warning triangle or (keys only) a tick.
//   on(event, fn), off(event, fn?)
//                     Listen for this control's events: "down", "up" (key or dial pressed and
//                     released), "rotate" (ev.ticks, ev.pressed), "touch" (ev.position, ev.hold),
//                     "appear", "disappear".
//
// Events (a control's events are also emitted by the Spoon, for every key and dial):
//   "down", "up", "rotate", "touch"   As for a control.
//   "appear"       A key or dial became visible: it was placed, or its page, folder or profile was
//                  shown, or its device was connected. When the plugin connects, there's one for
//                  every visible key and dial, with ev.initial set to true. ev.renamed is true when
//                  it's because the key's name was changed to this one.
//   "disappear"    The opposite: removed, or its page hidden, or ev.renamed if renamed away.
//                  The Elgato app doesn't tell plugins whether a key was deleted or just hidden.
//   "rename"       A key's name was changed in the Elgato app (ev.oldName, ev.name).
//   "connect", "disconnect"           The plugin connected or disconnected.
//   "deviceConnected", "deviceDisconnected", "deviceChanged"   With ev.device.
//   "error"        Something went wrong in the plugin, or the two speak different protocol
//                  versions (ev.message).
//
// Every key or dial event has:
//   name          The name it was given in the Elgato app ("" if it hasn't been given one yet)
//   id            The Elgato app's id for this placed key or dial (see "Instances")
//   instance      Its instance (see below)
//   control       The control for its name, or null if it hasn't got one
//   state         Keys: the state it's now in. userDesiredState: in a multi-action, the state the
//                 user chose for this step.
//
// Instances: each placed key or dial that's currently visible is an instance, with:
//   id                 Stays the same while it stays where it is, including across restarts; it
//                      changes if it's deleted and placed again, moved, or copied
//   kind               "key" or "dial"
//   name               Its name, or "" if it hasn't been given one
//   device             The device it's on: { id, name, type, typeName, size: { rows, columns }, connected }
//   coordinates        { row, column } on the device, or undefined inside a multi-action
//   isInMultiAction    Whether it's a step in a multi-action
//   state              Keys only: 0 or 1

const PROTOCOL_VERSION = 1
const SOCKET_DIR = "Library/Application Support/Hammerspoon2"
const SOCKET_FILE = "streamdeck.sock"
// The plugin only deletes temporary files whose names start with this
const TEMP_PREFIX = "hs2-streamdeck-"
const KEY_SIZE = 144
const VISUAL_FIELDS = ["image", "title", "state", "feedback", "layout", "triggerDescription"]

let listener = null
let connection = null        // the plugin's connection, once it has said hello
let pending = null           // a connection that hasn't said hello yet
let plugin = null            // the plugin's hello
let tempCounter = 0

const names = new Map()      // name -> Control
const ids = new Map()        // id -> Control
const instances = new Map()  // id -> instance
const devices = new Map()    // id -> device
const handlers = new Map()   // event -> [fn]

const deck = module.exports = {
    debug: false,

    start, stop,
    key: control, dial: control, control,
    instance: controlForId,
    instances: listInstances,
    devices: () => [...devices.values()],
    isConnected: () => connection !== null,
    on: (event, fn) => { addHandler(handlers, event, fn); return deck },
    off: (event, fn) => { removeHandler(handlers, event, fn); return deck }
}

// Events

function addHandler(map, event, fn) {
    if (typeof fn !== "function") throw new Error(`[StreamDeckPlugin] on("${event}") needs a function`)
    if (!map.has(event)) map.set(event, [])
    map.get(event).push(fn)
}

function removeHandler(map, event, fn) {
    if (!fn) { map.delete(event); return }
    const list = map.get(event)
    if (list) map.set(event, list.filter((f) => f !== fn))
}

function emitTo(map, event, ev) {
    for (const fn of map.get(event) || []) {
        try {
            fn(ev)
        } catch (err) {
            console.error(`[StreamDeckPlugin] Error in "${event}" handler: ${err && err.stack ? err.stack : err}`)
        }
    }
}

// Emits an instance's event on its id's control, its name's control, and the Spoon
function emitInstance(event, instance, extra, name) {
    if (name === undefined) name = instance.name
    const ev = Object.assign({
        type: event,
        name,
        id: instance.id,
        instance,
        control: name ? names.get(name) || null : null,
        state: instance.state
    }, extra)
    const byId = ids.get(instance.id)
    if (byId) emitTo(byId.handlers, event, ev)
    if (ev.control) emitTo(ev.control.handlers, event, ev)
    emitTo(handlers, event, ev)
}

// Controls

class Control {
    constructor(target) {
        this.target = target
        this.visual = {}       // what's been set: field -> the value as given
        this.handlers = new Map()
    }

    get name() { return this.target.name }
    get id() { return this.target.id }

    instances() {
        return [...instances.values()].filter((i) => this.target.id ? i.id === this.target.id : i.name === this.target.name)
    }

    setImage(image) { return this.set({ image }) }
    setTitle(title) { return this.set({ title: title == null ? null : String(title) }) }
    setState(state) { return this.set({ state: state == null ? null : Number(state) }) }
    setLayout(layout) { return this.set({ layout }) }
    setTriggerDescription(description) { return this.set({ triggerDescription: description }) }

    setFeedback(feedback) {
        if (feedback == null) {
            delete this.visual.feedback
        } else {
            this.visual.feedback = Object.assign({}, this.visual.feedback, feedback)
        }
        sendUpdate(this.target, { feedback })
        return this
    }

    set(fields) {
        for (const [field, value] of Object.entries(fields)) {
            if (value == null) delete this.visual[field]
            else this.visual[field] = value
        }
        sendUpdate(this.target, fields)
        return this
    }

    showAlert() { send({ type: "alert", target: this.target, kind: "alert" }); return this }
    showOk() { send({ type: "alert", target: this.target, kind: "ok" }); return this }

    on(event, fn) { addHandler(this.handlers, event, fn); return this }
    off(event, fn) { removeHandler(this.handlers, event, fn); return this }
}

function control(name) {
    if (typeof name !== "string" || !name.trim()) throw new Error("[StreamDeckPlugin] A key or dial's name must be a non-empty string")
    name = name.trim()
    let c = names.get(name)
    if (!c) {
        c = new Control({ name })
        names.set(name, c)
        send({ type: "knownNames", names: [...names.keys()] })
    }
    return c
}

function controlForId(id) {
    let c = ids.get(id)
    if (!c) {
        c = new Control({ id })
        ids.set(id, c)
    }
    return c
}

function listInstances(name) {
    const all = [...instances.values()]
    return name === undefined ? all : all.filter((i) => i.name === name)
}

// Images

function isHSImage(value) {
    return value !== null && typeof value === "object" && typeof value.saveToFile === "function"
}

// Converts an image the config gave us into what the plugin accepts, noting any temporary file
// the plugin should delete once it has read it
function encodeImage(value, deleteFiles, maxSize) {
    if (!isHSImage(value)) return value
    let image = value
    const size = image.size
    if (maxSize && (size.w > maxSize || size.h > maxSize)) {
        const scale = maxSize / Math.max(size.w, size.h)
        image = image.duplicate()
        image.size = new HSSize(Math.round(size.w * scale), Math.round(size.h * scale))
    }
    if (typeof image.toDataURL === "function") return image.toDataURL()
    const path = `${hs.fs.tempDirectory().replace(/\/$/, "")}/${TEMP_PREFIX}${Date.now()}-${++tempCounter}.png`
    if (!image.saveToFile(path)) throw new Error(`Couldn't save image to ${path}`)
    deleteFiles.push(path)
    return path
}

// Turns a control's fields into an update message's fields
function encodeVisual(fields) {
    const result = {}
    const deleteFiles = []
    for (const field of VISUAL_FIELDS) {
        if (!(field in fields)) continue
        const value = fields[field]
        if (value == null) {
            result[field] = null
        } else if (field === "image") {
            result.image = encodeImage(value, deleteFiles, KEY_SIZE)
        } else if (field === "feedback") {
            const feedback = {}
            for (const [key, item] of Object.entries(value)) {
                if (isHSImage(item)) {
                    feedback[key] = encodeImage(item, deleteFiles)
                } else if (item && typeof item === "object" && isHSImage(item.value)) {
                    feedback[key] = Object.assign({}, item, { value: encodeImage(item.value, deleteFiles) })
                } else {
                    feedback[key] = item
                }
            }
            result.feedback = feedback
        } else {
            result[field] = value
        }
    }
    if (deleteFiles.length) result.deleteFiles = deleteFiles
    return result
}

// The connection

function log(message) {
    if (deck.debug) console.debug(`[StreamDeckPlugin] ${message}`)
}

function send(message) {
    if (!connection) return
    const line = JSON.stringify(message)
    log(`-> ${line.length > 300 ? line.slice(0, 300) + "…" : line}`)
    connection.write(line + "\n")
}

function sendUpdate(target, fields) {
    if (!connection) return    // it's all sent in the state message when the plugin connects
    try {
        send(Object.assign({ type: "update", target }, encodeVisual(fields)))
    } catch (err) {
        console.error(`[StreamDeckPlugin] Couldn't update ${target.name || target.id}: ${err.message || err}`)
    }
}

function sendState() {
    const message = { type: "state", names: {}, ids: {}, knownNames: [...names.keys()] }
    const add = (into, key, c) => {
        if (Object.keys(c.visual).length === 0) return
        try {
            into[key] = encodeVisual(c.visual)
        } catch (err) {
            console.error(`[StreamDeckPlugin] Couldn't send ${key}: ${err.message || err}`)
        }
    }
    for (const [name, c] of names) add(message.names, name, c)
    for (const [id, c] of ids) add(message.ids, id, c)
    send(message)
}

function resolveInstance(raw) {
    return {
        id: raw.id,
        kind: raw.kind,
        name: raw.name || "",
        device: devices.get(raw.device) || { id: raw.device },
        coordinates: raw.coordinates,
        isInMultiAction: !!raw.isInMultiAction,
        state: raw.state
    }
}

function handleMessage(sock, message) {
    if (sock === pending) {
        if (message.type !== "hello") return
        pending = null
        if (message.protocol !== PROTOCOL_VERSION) {
            const update = message.protocol > PROTOCOL_VERSION ? "the StreamDeckPlugin Spoon" : "the Hammerspoon 2 Stream Deck plugin"
            const text = `The Stream Deck plugin (${message.plugin}) speaks protocol ${message.protocol}, ` +
                `but this Spoon speaks ${PROTOCOL_VERSION}: update ${update}`
            console.error(`[StreamDeckPlugin] ${text}`)
            emitTo(handlers, "error", { type: "error", message: text })
            // Say hello so the plugin can report it too, then leave the connection idle
            sock.write(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, spoon: deck.version || "?" }) + "\n")
            return
        }
        if (connection) connection.disconnect()
        connection = sock
        plugin = message
        console.info(`[StreamDeckPlugin] Stream Deck plugin ${message.plugin} connected (Stream Deck ${message.streamDeck})`)
        send({ type: "hello", protocol: PROTOCOL_VERSION, spoon: deck.version || "?" })
        return
    }
    if (sock !== connection) return

    switch (message.type) {
        case "snapshot": {
            devices.clear()
            for (const d of message.devices || []) devices.set(d.id, d)
            instances.clear()
            for (const raw of message.instances || []) instances.set(raw.id, resolveInstance(raw))
            sendState()
            emitTo(handlers, "connect", { type: "connect", plugin: plugin.plugin, streamDeck: plugin.streamDeck })
            for (const instance of instances.values()) emitInstance("appear", instance, { initial: true })
            break
        }
        case "appear": {
            const instance = resolveInstance(message.instance)
            instances.set(instance.id, instance)
            emitInstance("appear", instance, {})
            break
        }
        case "disappear": {
            const instance = instances.get(message.instance.id) || resolveInstance(message.instance)
            instances.delete(instance.id)
            emitInstance("disappear", instance, {})
            break
        }
        case "rename": {
            const instance = instances.get(message.instance.id) || resolveInstance(message.instance)
            const oldName = message.oldName || ""
            instance.name = message.instance.name || ""
            instances.set(instance.id, instance)
            if (oldName) emitInstance("disappear", instance, { renamed: true, oldName }, oldName)
            emitTo(handlers, "rename", { type: "rename", name: instance.name, oldName, id: instance.id, instance })
            if (instance.name) emitInstance("appear", instance, { renamed: true, oldName })
            break
        }
        case "keyDown":
        case "keyUp":
        case "dialDown":
        case "dialUp":
        case "dialRotate":
        case "touchTap": {
            const instance = instances.get(message.instance.id) || resolveInstance(message.instance)
            if (message.instance.state !== undefined) instance.state = message.instance.state
            const event = { keyDown: "down", keyUp: "up", dialDown: "down", dialUp: "up", dialRotate: "rotate", touchTap: "touch" }[message.type]
            const extra = {}
            for (const field of ["userDesiredState", "ticks", "pressed", "position", "hold"]) {
                if (message[field] !== undefined) extra[field] = message[field]
            }
            emitInstance(event, instance, extra)
            break
        }
        case "deviceConnected":
        case "deviceDisconnected":
        case "deviceChanged": {
            devices.set(message.device.id, message.device)
            for (const instance of instances.values()) {
                if (instance.device.id === message.device.id) instance.device = message.device
            }
            emitTo(handlers, message.type, { type: message.type, device: message.device })
            break
        }
        case "error":
            console.error(`[StreamDeckPlugin] Plugin error: ${message.message}`)
            emitTo(handlers, "error", { type: "error", message: message.message })
            break
    }
}

function onSocketEvent(event, sock, data) {
    switch (event) {
        case "connection":
            // The plugin says hello first; until it does, this is just a pending connection
            if (pending) pending.disconnect()
            pending = data
            data.readUntil("\n")
            break
        case "data": {
            const line = hs.socket.decodeText(data)
            if (sock !== pending && sock !== connection) return
            sock.readUntil("\n")
            if (line === null || !line.trim()) return
            log(`<- ${line.length > 300 ? line.slice(0, 300) + "…" : line.trimEnd()}`)
            let message
            try {
                message = JSON.parse(line)
            } catch (err) {
                console.warn(`[StreamDeckPlugin] Ignoring malformed message: ${line.slice(0, 200)}`)
                return
            }
            handleMessage(sock, message)
            break
        }
        case "error":
            if (sock === listener) console.error(`[StreamDeckPlugin] ${data}`)
            else log(`Socket error: ${data}`)
            break
        case "disconnected":
            if (sock === pending) pending = null
            if (sock === connection) {
                connection = null
                plugin = null
                instances.clear()
                console.info("[StreamDeckPlugin] Stream Deck plugin disconnected")
                emitTo(handlers, "disconnect", { type: "disconnect" })
            }
            if (sock === listener) listener = null
            break
    }
}

function start() {
    if (listener) return deck
    const dir = `${hs.fs.homeDirectory().replace(/\/$/, "")}/${SOCKET_DIR}`
    if (!hs.fs.isDirectory(dir) && !hs.fs.mkdir(dir)) {
        console.error(`[StreamDeckPlugin] Couldn't create ${dir}`)
        return deck
    }
    listener = hs.socket.create().setCallback(onSocketEvent).listenUnix(`${dir}/${SOCKET_FILE}`)
    console.info("[StreamDeckPlugin] started")
    return deck
}

function stop() {
    const sock = listener
    listener = null
    if (sock) sock.disconnect()   // also disconnects the plugin, which then retries until we're back
    console.info("[StreamDeckPlugin] stopped")
    return deck
}
