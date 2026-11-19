/*!
 * Epic 3D Card Reveal
 * 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { MODULE_ID, SETTINGS } from "./constants.js";
import { postCardToChat, resolveSendToChat, resolveShowDescription } from "./helpers.js";
import FancyDisplay, { CardViewerApp } from "./fancy-display.js";
import CardDealer from "./card-dealer.js";

const TEMPLATE = `modules/${MODULE_ID}/templates/card-picker.hbs`;
const SOCKET_EVENT = `module.${MODULE_ID}`;

/**
 * Socket message types of the pick flow. Every message rides the module's single native socket channel as
 * `{type, payload}`, next to the viewer's `shareToAll`, and every payload carries the `sessionId` it belongs to.
 * - START:  initiating GM → everyone. Opens the scene (seed, picker, card count, back image, captions, appearance).
 * - HOVER:  picker or a GM → everyone. The fan index under that user's pointer, or -1.
 * - CHOOSE: picker or a GM → initiating GM. The clicked fan index; the first one the GM receives wins.
 * - REVEAL: initiating GM → everyone. The clicked index plus the data of the card that was actually drawn.
 * - CANCEL: initiating GM → everyone. Closes the scene before a card was chosen.
 */
const MSG = {
    START: "pickStart",
    HOVER: "pickHover",
    CHOOSE: "pickChoose",
    REVEAL: "pickReveal",
    CANCEL: "pickCancel"
};

/** Default number of cards shown in the fan when the caller passes no `maxCards`. */
const DEFAULT_MAX_CARDS = 24;

/** Default captions. `{name}` in the spectator caption is replaced by the picker's user name. */
const DEFAULT_PROMPTS = {
    picker: "Pick a card",
    spectator: "{name} is picking a card…",
    gm: "Click a card to pick it for {name}",
    cancel: "Esc or ✕ to cancel"
};

/**
 * Bundled sounds of the pick phases (Kenney "Casino Audio", CC0), used when the caller passes no `sounds` entry.
 * `shuffle` plays once per riffle as the cards fall, `fan` as the deck spreads, `hover` on every newly hovered
 * card, `pick` when a card is pulled out of the fan.
 */
const DEFAULT_SOUNDS = {
    shuffle: `modules/${MODULE_ID}/assets/pick-riffle.ogg`,
    fan: `modules/${MODULE_ID}/assets/pick-fan.ogg`,
    hover: `modules/${MODULE_ID}/assets/pick-hover.ogg`,
    pick: `modules/${MODULE_ID}/assets/pick-take.ogg`
};

/** The hover tick repeats with every card the pointer crosses, so it plays well under the other sounds. */
const HOVER_VOLUME = 0.35;

/** Roughly how long the chosen card takes from the click to sitting in the viewer (lift + flight), in ms. */
const REVEAL_LEAD_MS = 1400;

/** Minimum gap between two broadcast hover messages from one client (ms). */
const HOVER_THROTTLE_MS = 70;

/** Minimum gap between two hover sounds on one client (ms), so sweeping across the fan doesn't machine-gun. */
const HOVER_SOUND_GAP_MS = 90;

/**
 * Pose of the deck while it is shuffled: lying back, slightly turned, so the stack shows its thickness.
 * Degrees. See {@link poseCSS} for how a pose maps to a transform.
 */
const DECK_RX = 44;
const DECK_RZ = -5;

/** Easing curves shared by the phases, so every move in the scene has the same feel. */
const EASE = {
    out: "cubic-bezier(0.16, 1, 0.3, 1)",
    inOut: "cubic-bezier(0.45, 0, 0.2, 1)",
    drop: "cubic-bezier(0.4, 0, 0.2, 1)",
    fall: "cubic-bezier(0.5, 0, 0.75, 0)",
    flight: "cubic-bezier(0.3, 0.7, 0.2, 1)"
};

/**
 * The local pick session on this client, or null. Exactly one at a time per client.
 * @type {{sessionId:string, gmId:string, pickerId:string, app:CardPickApp}|null}
 */
let scene = null;

/**
 * The initiating GM's authority over the session it started, or null. Lives only on that GM's client.
 * @type {object|null}
 */
let authority = null;

/* -------------------------------------------- */
/*  Pure helpers                                */
/* -------------------------------------------- */

/**
 * Small seeded PRNG (mulberry32). Every client builds the same shuffle from the seed in the start message.
 * @param {number} seed  32-bit seed.
 * @returns {() => number} A function returning floats in [0, 1).
 */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * A card pose in stage coordinates (origin at the viewport center, px and degrees). Every animation of the
 * pose wrapper goes between two poses rendered by this one function, so both keyframes always carry the same
 * transform-function list and the browser interpolates each function on its own (no matrix decomposition, no
 * surprising arcs). `x/y/z` place the card, `rx/ry/rz` orient it, `lx/ly/lz` offset it inside the rotated frame
 * (the stack thickness along the card normal), `sx/sy` scale the full-size card element down to the shown size.
 * @typedef {{x:number, y:number, z:number, rx:number, ry:number, rz:number, lx:number, ly:number, lz:number, sx:number, sy:number}} Pose
 * @param {Pose} p
 * @returns {string} A CSS transform.
 */
function poseCSS(p) {
    const n = (v) => Math.round(v * 1000) / 1000;
    return `translate3d(${n(p.x)}px, ${n(p.y)}px, ${n(p.z)}px) rotateX(${n(p.rx)}deg) rotateY(${n(p.ry)}deg) `
        + `rotateZ(${n(p.rz)}deg) translate3d(${n(p.lx)}px, ${n(p.ly)}px, ${n(p.lz)}px) scale(${n(p.sx)}, ${n(p.sy)})`;
}

/**
 * Load and decode an image, never rejecting and never waiting longer than `timeout`.
 * @param {string} src
 * @param {number} [timeout=4000]
 * @returns {Promise<HTMLImageElement|null>} The decoded image, or null on failure/timeout.
 */
function loadImage(src, timeout = 4000) {
    if (!src) return Promise.resolve(null);
    return new Promise((resolve) => {
        const img = new Image();
        const timer = setTimeout(() => resolve(img.naturalWidth ? img : null), timeout);
        img.src = src;
        img.decode()
            .then(() => resolve(img))
            .catch(() => resolve(null))
            .finally(() => clearTimeout(timer));
    });
}

/**
 * Play one of the optional phase sounds (`sounds.shuffle/fan/hover/pick`) locally. Empty or missing paths are a
 * silent no-op, and a file that fails to load never breaks the scene.
 * @param {string} src            Audio path, or empty for none.
 * @param {{soundVolume?:number, soundChannel?:string}} appearance  Resolved volume/channel of the reveal sound.
 * @param {number} [gain=1]       Extra volume factor on top of the resolved volume.
 */
function playPhaseSound(src, appearance, gain = 1) {
    if (!src || typeof src !== "string") return;
    try {
        // socketOptions `false`: local playback only, every client plays its own copy at the matching moment.
        const played = foundry.audio.AudioHelper.play({
            src,
            volume: (appearance?.soundVolume ?? 0.8) * gain,
            channel: appearance?.soundChannel,
            autoplay: true,
            loop: false
        }, false);
        played?.catch?.((error) => console.warn(`${MODULE_ID} | Could not play pick sound "${src}".`, error));
    } catch (error) {
        console.warn(`${MODULE_ID} | Could not play pick sound "${src}".`, error);
    }
}

/**
 * Resolve a Cards stack from an id, a uuid or a name.
 * @param {string|Cards} value
 * @returns {Cards|null}
 */
function resolveStack(value) {
    if (!value) return null;
    if (value instanceof foundry.utils.getDocumentClass("Cards")) return value;
    if (typeof value !== "string") return null;
    let doc = game.cards.get(value);
    if (!doc && value.includes(".")) {
        try {
            doc = fromUuidSync(value);
        } catch {
            doc = null;
        }
    }
    doc ??= game.cards.getName(value);
    return doc?.documentName === "Cards" ? doc : null;
}

/**
 * Lay out the scene for the current viewport: the full card size (the size the viewer will show the card at),
 * the deck, and the fan. The fan is offered to the player: its pivot sits above it, where the dealer's hand
 * would be, and the cards radiate down toward the viewer, so the arc bulges toward the player (a "∪"). Its card
 * size, radius and spacing shrink together until the fan plus the hover pull fit the free area under the
 * caption, so 5 cards and 24 cards both fill the screen without overflowing it.
 *
 * Card elements are built at the size the fan shows them (`elemW`×`elemH`), not at the viewer's size: every card
 * is a composited layer, and two dozen viewer-sized layers cost a weak GPU most of its frame rate. Only the
 * chosen card is rebuilt at full size, the moment it is picked (see {@link CardPickApp#_promote}), so its flight
 * into the viewer stays sharp.
 * @param {number} count   Cards in the fan.
 * @param {number} aspect  Width / height of the back image.
 * @returns {object} Layout values in px (stage coordinates: origin at the viewport center).
 */
function computeLayout(count, aspect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // The viewer shows a card at up to 85vh tall inside a 75vw-wide area (see card-viewer.css).
    let cardH = vh * 0.85;
    let cardW = cardH * aspect;
    if (cardW > vw * 0.75) {
        cardW = vw * 0.75;
        cardH = cardW / aspect;
    }

    // Fan: free area below the caption. Cards sit on an arc around a pivot 2.2 card heights above them; the
    // angle between neighbours shrinks with the card count (14° for a handful, ~3.5° for two dozen), so small
    // fans spread wide and big ones overlap like a real spread of cards.
    const top = vh * 0.2;
    const bottom = vh * 0.97;
    const maxWidth = vw * 0.92;
    const n = Math.max(1, count);
    // Past two dozen cards the 3.4° floor would let the arc grow without bound (a 78-card tarot deck would wrap
    // around its own pivot), so the whole fan is capped at 100° and the cards simply overlap more.
    const step = n > 1 ? Math.min(14, Math.max(3.4, 80 / (n - 1)), 100 / (n - 1)) * Math.PI / 180 : 0;
    let fanH = Math.min(cardH, vh * 0.5);
    let fit;
    for (let iter = 0; iter < 60; iter++) {
        const fanW = fanH * aspect;
        const radius = fanH * 2.2;
        const spacing = radius * step;
        // Neighbours give way to uncover most of the hovered card (see CardPickApp#_renderHover).
        const giveWay = Math.max(0, fanW - spacing) * 0.62;

        // Bounding box of every card, including the hovered card's pull toward the player (its near edge
        // travels further out) and the neighbours giving way.
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < n; i++) {
            const theta = (i - (n - 1) / 2) * step;
            const cx = radius * Math.sin(theta);
            const cy = radius * Math.cos(theta);
            for (const [dx, dy] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
                const px = dx * fanW * 1.06;
                const py = dy * fanH * 1.06 + (dy > 0 ? fanH * 0.14 : 0);
                // The card is turned by -theta, so that its long axis lies on the radius.
                const x = cx + px * Math.cos(theta) + py * Math.sin(theta);
                const y = cy - px * Math.sin(theta) + py * Math.cos(theta);
                minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            }
        }
        minX -= giveWay * 0.4; maxX += giveWay * 0.4;
        fit = { fanH, fanW, radius, step, spacing, giveWay, minX, maxX, minY, maxY };
        if ((maxX - minX) <= maxWidth && (maxY - minY) <= (bottom - top)) break;
        fanH *= 0.96;
    }

    // Place the pivot so the fan's bounding box sits centered in the free area.
    const pivotX = -(fit.minX + fit.maxX) / 2;
    const pivotY = (top + bottom) / 2 - vh / 2 - (fit.minY + fit.maxY) / 2;
    const fan = [];
    for (let i = 0; i < n; i++) {
        const theta = (i - (n - 1) / 2) * fit.step;
        fan.push({
            theta,
            x: pivotX + fit.radius * Math.sin(theta),
            y: pivotY + fit.radius * Math.cos(theta)
        });
    }

    // Card elements are fan-sized, so the fan (the state looked at longest) is drawn 1:1.
    const elemH = fit.fanH;
    const elemW = fit.fanW;

    // Deck: centered, a little low, lying back. Half of the screen height for a handful of cards; never more
    // than 1.3 times the element size, so the up-scaled stack stays crisp.
    const deckH = Math.min(vh * 0.52, cardH, elemH * 1.3);
    const deckS = deckH / elemH;
    const deckGap = Math.min(3, Math.max(1, deckH * 0.006));
    const deckY = vh * 0.03;

    return {
        vw, vh, cardW, cardH, elemW, elemH,
        deckS, deckH, deckW: deckH * aspect, deckGap, deckY,
        fanS: 1, fanH: fit.fanH, fanW: fit.fanW, fanGap: 0.8,
        radius: fit.radius, step: fit.step, spacing: fit.spacing, giveWay: fit.giveWay,
        pivotX, pivotY, fan
    };
}

/* -------------------------------------------- */
/*  The scene                                   */
/* -------------------------------------------- */

/**
 * Full-screen "pick a card" scene, rendered on every connected client: a deck is shuffled, spread into a fan,
 * the picker chooses a card, and the chosen card flies into a {@link CardViewerApp} that runs the module's
 * usual dramatic reveal. Driven by {@link CardPicker}; not exported on the module API.
 *
 * Each card is a stack of nested wrappers so independent motions compose instead of fighting over one
 * `transform`:
 * - `.cp-card`        pose: deck / shuffle / fan / collapse / flight, animated with WAAPI between {@link Pose}s;
 * - `.cp-card-hover`  hover lift and neighbours giving way, a CSS transition;
 * - `.cp-card-flight` a short depth "bump" during the flight;
 * - leaves (glow, shadow, image) that only ever fade, so no opacity ever flattens the 3D chain.
 */
class CardPickApp extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
    /** @override */
    static DEFAULT_OPTIONS = {
        id: "card-pick-{id}",
        classes: [MODULE_ID, "card-pick-app"],
        tag: "div",
        window: {
            frame: false,
            positioned: false
        },
        actions: {
            cancel: CardPickApp.prototype._onCancelAction
        }
    };

    /** @override */
    static PARTS = {
        stage: { template: TEMPLATE }
    };

    /**
     * @param {object} options
     * @param {object} options.session  The start payload (see {@link CardPicker.pick}).
     */
    constructor(options = {}) {
        super(options);
        this.session = options.session;
        this.rng = mulberry32(this.session.seed);
        this.count = this.session.count;
        this.picker = game.users.get(this.session.pickerId);
        // The picker and every GM may hover and click; everyone else watches.
        this.isInteractor = game.user.id === this.session.pickerId || game.user.isGM;
        this.canCancel = game.user.id === this.session.gmId;
        /** "intro" → "choosing" → "picked" → "revealing" → "handover"; "closing" when dismissed. */
        this.phase = "intro";
        this.cards = [];
        this.hoverIndex = -1;
        /** Fan index under this client's own pointer, and the last hover received from each other user. */
        this._localHover = -1;
        this._remoteHovers = new Map();
        this.pickedIndex = -1;
        this._timers = new Set();
        this._allowClose = false;
        this._lastHoverSent = 0;
        this._hoverSendTimer = null;
        this._lastHoverSound = 0;
        this._pickSoundPlayed = false;
        // Resolved when the fan is in place and the choice opens; a reveal waits for it, so a client whose
        // run-up started late still plays the whole sequence instead of jumping.
        this._fanReady = new Promise((resolve) => { this._resolveFanReady = resolve; });
    }

    /** @override */
    async _prepareContext(_options) {
        const { session } = this;
        const name = this.picker?.name ?? "";
        const isPicker = game.user.id === session.pickerId;
        const title = isPicker ? session.prompts.picker : session.prompts.spectator.replaceAll("{name}", name);
        // GMs who are not the picker may still pick on the player's behalf; tell them so.
        const hints = [];
        if (!isPicker && game.user.isGM) hints.push((session.prompts.gm ?? DEFAULT_PROMPTS.gm).replaceAll("{name}", name));
        if (this.canCancel) hints.push(session.prompts.cancel ?? DEFAULT_PROMPTS.cancel);
        const subtitle = hints.filter(Boolean).join(" — ");
        return {
            title,
            subtitle,
            canCancel: this.canCancel,
            glowShadow: CardViewerApp._composeGlowShadow(session.appearance.glowColor, session.appearance.glowIntensity)
        };
    }

    /** @override */
    _onFirstRender(_context, _options) {
        this.stage = this.element.querySelector(".cp-stage");
        this.fanEl = this.element.querySelector(".cp-fan");
        this.sceneEl = this.element.querySelector(".cp-scene");
        this.backdrop = this.element.querySelector(".cp-backdrop");
        this.caption = this.element.querySelector(".cp-caption");
        this._injectSparkles();
        // The backdrop is dark from the first frame, like the viewer's; the cards rise in as soon as the back
        // image is decoded.
        this._start();
    }

    /**
     * Scatter the viewer's glowing orbs over the whole stage, so the scene has the same air as the reveal it
     * leads into. Positions come from the seed (every client sees the same sky) through a PRNG of their own, so
     * the shuffle's random stream stays untouched. They fade in with the deck and out again as the chosen card
     * flies off, where the viewer's own orbs take over.
     */
    _injectSparkles() {
        const box = this.element.querySelector(".cp-orbs");
        if (!box) return;
        const rng = mulberry32((this.session.seed ^ 0x9E3779B9) >>> 0);
        for (let i = 0; i < 26; i++) {
            const orb = document.createElement("div");
            orb.className = "cp-orb";
            const size = 12 + Math.round(rng() * 24);
            orb.style.left = `${4 + rng() * 92}%`;
            orb.style.top = `${5 + rng() * 90}%`;
            orb.style.width = orb.style.height = `${size}px`;
            orb.style.animationDuration = `${9000 + rng() * 9000}ms, ${2200 + rng() * 2600}ms`;
            orb.style.animationDelay = `${-rng() * 9000}ms, ${-rng() * 3000}ms`;
            box.appendChild(orb);
        }
        requestAnimationFrame(() => box.classList.add("cp-visible"));
    }

    /**
     * Refuse every close that isn't the scene's own (Esc, other modules' "close all" sweeps...). Before the
     * reveal only the initiating GM may end the scene, through {@link CardPicker.cancel}.
     * @override
     */
    async close(options = {}) {
        if (!this._allowClose) return this;
        return super.close({ ...options, animate: false });
    }

    /** @override */
    _onClose(options) {
        super._onClose(options);
        for (const t of this._timers) clearTimeout(t);
        this._timers.clear();
        clearTimeout(this._hoverSendTimer);
        window.removeEventListener("resize", this._onResize);
        // Let a reveal that is still waiting for the fan run on to its own "closed meanwhile" exit.
        this._resolveFanReady();
        if (scene?.app === this) scene = null;
    }

    /** Close button handler (initiating GM only). */
    _onCancelAction() {
        CardPicker.cancel(this.session.sessionId);
    }

    /**
     * setTimeout tracked for cleanup on close.
     * @param {() => void} fn
     * @param {number} ms
     */
    _later(fn, ms) {
        const t = setTimeout(() => {
            this._timers.delete(t);
            if (this.rendered) fn();
        }, ms);
        this._timers.add(t);
        return t;
    }

    /* ---------------------- run-up ---------------------- */

    /**
     * Build the cards and schedule the whole run-up (intro → two riffles → fan) up front. Every pose change is
     * a WAAPI animation with an absolute delay; consecutive animations of one card chain from the pose the
     * previous one ends on, so nothing ever jumps.
     */
    async _start() {
        const backImg = await loadImage(this.session.back);
        if (!this.rendered) return;
        const aspect = backImg?.naturalWidth && backImg?.naturalHeight ? backImg.naturalWidth / backImg.naturalHeight : 2 / 3;
        this.aspect = aspect;
        const L = this.layout = computeLayout(this.count, aspect);
        this.stage.style.setProperty("--cp-card-w", `${L.elemW}px`);
        this.stage.style.setProperty("--cp-card-h", `${L.elemH}px`);

        // Build the cards. card.id is the initial stack position; `order` is the stack bottom → top.
        const frag = document.createDocumentFragment();
        for (let i = 0; i < this.count; i++) {
            const el = document.createElement("div");
            el.className = "cp-card";
            el.innerHTML = `<div class="cp-card-hover"><div class="cp-card-flight">`
                + `<div class="cp-card-glow"></div><div class="cp-card-shade"></div>`
                + `<div class="cp-card-body"><img class="cp-card-img" alt="" draggable="false"><div class="cp-card-shine"></div></div>`
                + `</div></div>`;
            el.querySelector(".cp-card-img").src = this.session.back;
            const card = {
                id: i, el, anims: [], pose: null, fanIndex: -1,
                hover: el.querySelector(".cp-card-hover"),
                flight: el.querySelector(".cp-card-flight"),
                glow: el.querySelector(".cp-card-glow"),
                shade: el.querySelector(".cp-card-shade"),
                body: el.querySelector(".cp-card-body")
            };
            this.cards.push(card);
            frag.appendChild(el);
        }
        this.fanEl.appendChild(frag);

        let order = [...this.cards];
        const deckPose = (k, j = null) => ({
            x: 0, y: L.deckY, z: 0, rx: DECK_RX, ry: 0, rz: DECK_RZ + (j?.rz ?? 0),
            lx: j?.x ?? 0, ly: j?.y ?? 0, lz: k * L.deckGap, sx: L.deckS, sy: L.deckS
        });

        // 1. Intro: the deck rises out of the dark in a quick bottom-to-top cascade.
        let t = 60;
        const introStagger = Math.min(12, 240 / this.count);
        for (const card of order) {
            const k = card.id;
            const from = { ...deckPose(k), y: L.deckY + L.vh * 0.14, z: -260, rx: DECK_RX + 16, rz: DECK_RZ - 4 };
            card.pose = from;
            card.el.style.transform = poseCSS(from);
            this._animatePose(card, deckPose(k), { delay: t + k * introStagger, duration: 700, easing: EASE.out });
            card.body.animate([{ opacity: 0 }, { opacity: 1 }],
                { delay: t + k * introStagger, duration: 420, easing: "ease-out", fill: "backwards" });
        }
        t += 700 + (this.count - 1) * introStagger - 120;

        // 2. Two riffle shuffles, the second mirrored.
        for (const side of [1, -1]) {
            const result = this._scheduleRiffle(order, t, side, deckPose);
            order = result.order;
            t = result.end;
        }

        // 3. Spread into the fan, bottom card first, so the spread sweeps left to right.
        order.forEach((card, i) => { card.fanIndex = i; });
        this.fanOrder = order;
        this._later(() => playPhaseSound(this.session.sounds.fan, this.session.appearance), t);
        const fanStagger = Math.min(24, 300 / this.count);
        const fanDur = 950;
        for (const card of order) {
            const i = card.fanIndex;
            this._animatePose(card, this._fanPose(i), { delay: t + i * fanStagger, duration: fanDur, easing: EASE.out });
        }
        const fanEnd = t + fanDur + (this.count - 1) * fanStagger;
        this._later(() => this.caption.classList.add("cp-visible"), fanEnd - 450);
        this._later(() => this._openChoice(), fanEnd);
    }

    /**
     * Pose of fan slot `i`.
     * @param {number} i
     * @returns {Pose}
     */
    _fanPose(i) {
        const L = this.layout;
        const slot = L.fan[i];
        return {
            x: slot.x, y: slot.y, z: 0, rx: 0, ry: 0, rz: -slot.theta * 180 / Math.PI,
            lx: 0, ly: 0, lz: i * L.fanGap, sx: L.fanS, sy: L.fanS
        };
    }

    /**
     * Schedule one riffle shuffle starting at `t0`: cut the deck, lift the two packets apart, let their cards
     * fall back into one pile alternately (Gilbert–Shannon–Reeds: the next card comes from a packet with odds
     * proportional to its size, all from the seeded PRNG), then square the pile up.
     * @param {Array<object>} order  Stack bottom → top.
     * @param {number} t0            Start time (ms after the scene start).
     * @param {1|-1} side            Which side the top packet goes to.
     * @param {(k:number, j?:object) => Pose} deckPose
     * @returns {{order:Array<object>, end:number}}
     */
    _scheduleRiffle(order, t0, side, deckPose) {
        const L = this.layout;
        const n = order.length;
        if (n < 2) return { order, end: t0 };
        const rng = this.rng;
        const cut = Math.max(1, Math.min(n - 1, Math.round(n / 2 + (rng() - 0.5) * n * 0.2)));
        const bottom = order.slice(0, cut);
        const top = order.slice(cut);
        const dx = L.deckW * 0.6;

        // Split: the top packet is lifted off and moves out first, the bottom one follows.
        const packetPose = (s, k) => ({
            // Inner edges up, like packets bent under the thumbs: the cards then spring down onto the pile from
            // above it and never cut through it.
            x: s * dx, y: L.deckY - L.deckH * 0.03, z: 34, rx: DECK_RX, ry: s * 20, rz: DECK_RZ + s * 10,
            lx: 0, ly: 0, lz: k * L.deckGap, sx: L.deckS, sy: L.deckS
        });
        const splitDur = 340;
        top.forEach((card, k) => this._animatePose(card, packetPose(side, k), { delay: t0, duration: splitDur, easing: EASE.inOut }));
        bottom.forEach((card, k) => this._animatePose(card, packetPose(-side, k), { delay: t0 + 50, duration: splitDur, easing: EASE.inOut }));

        // Interleave: bottoms of the packets fall first; each card lands a little askew.
        const left = [...bottom];
        const right = [...top];
        const next = [];
        while (left.length || right.length) {
            const pickLeft = right.length === 0 || (left.length > 0 && rng() < left.length / (left.length + right.length));
            next.push(pickLeft ? left.shift() : right.shift());
        }
        const interval = Math.min(30, 400 / n);
        const dropDur = 320;
        const dropStart = t0 + splitDur + 60;
        this._later(() => playPhaseSound(this.session.sounds.shuffle, this.session.appearance), dropStart);
        next.forEach((card, j) => {
            const jitter = {
                rz: (rng() - 0.5) * 5,
                x: (rng() - 0.5) * L.deckW * 0.03,
                y: (rng() - 0.5) * L.deckH * 0.02
            };
            card._jitter = jitter;
            // Each card springs off its packet in a small arc: up and halfway in, levelling out, then down
            // onto the pile.
            const to = deckPose(j, jitter);
            const from = card.pose;
            const via = {
                ...to, x: from.x * 0.42, y: to.y - L.deckH * 0.05, z: 46 + L.deckH * 0.08,
                rx: DECK_RX - 7, ry: from.ry * 0.45, rz: (from.rz + to.rz) / 2
            };
            this._animatePose(card, to, { delay: dropStart + j * interval, duration: dropDur, via });
        });

        // Square up: every card slides back into a clean stack.
        const squareStart = dropStart + (n - 1) * interval + dropDur + 40;
        const squareDur = 220;
        next.forEach((card, j) => this._animatePose(card, deckPose(j), { delay: squareStart, duration: squareDur, easing: EASE.out }));
        return { order: next, end: squareStart + squareDur };
    }

    /**
     * Animate a card's pose wrapper from the pose it was last sent to, to `to`. Animations only fill forwards,
     * so a queued animation never overrides the one before it until its own delay is over.
     * @param {object} card
     * @param {Pose} to
     * @param {{delay?:number, duration:number, easing?:string, via?:Pose, viaAt?:number}} timing  With `via`
     *   the card passes through that pose at `viaAt` (0..1) of the way: it decelerates into it and accelerates
     *   out of it, the way a tossed card rises and falls; `easing` is not used then.
     * @returns {Animation}
     */
    _animatePose(card, to, { delay = 0, duration, easing = "linear", via = null, viaAt = 0.45 }) {
        const from = card.pose;
        card.pose = to;
        const keyframes = via
            ? [
                { transform: poseCSS(from), easing: "cubic-bezier(0.2, 0.6, 0.35, 1)" },
                { transform: poseCSS(via), offset: viaAt, easing: "cubic-bezier(0.55, 0, 0.8, 0.45)" },
                { transform: poseCSS(to) }
            ]
            : [{ transform: poseCSS(from) }, { transform: poseCSS(to) }];
        const anim = card.el.animate(keyframes, { delay, duration, easing: via ? "linear" : easing, fill: "forwards" });
        card.anims.push(anim);
        return anim;
    }

    /**
     * Freeze a card on the pose it was last sent to: write it inline and drop the finished animations, so the
     * card carries no stale fill-forwards animations into the next phase.
     * @param {object} card
     */
    _settle(card) {
        card.el.style.transform = poseCSS(card.pose);
        for (const a of card.anims) a.cancel();
        card.anims = [];
    }

    /* ---------------------- choice ---------------------- */

    /** The fan is in place: settle the cards and open the choice to the picker (and GMs). */
    _openChoice() {
        // Dismissed (cancel, GM gone) while the fan was still spreading: the scene is fading out, leave it be.
        if (this.phase !== "intro") return;
        for (const card of this.cards) this._settle(card);
        this.phase = "choosing";
        this.stage.classList.add("cp-choosing");
        if (this.isInteractor) {
            this.stage.classList.add("cp-interactive");
            this.stage.addEventListener("pointermove", (event) => this._onPointerMove(event));
            this.stage.addEventListener("pointerleave", () => this._setLocalHover(-1));
            this.stage.addEventListener("click", (event) => this._onClick(event));
        }
        window.addEventListener("resize", this._onResize);
        this._resolveFanReady();
        // Hovers that arrived from other clients while the fan was still spreading.
        this._showHover(false);
    }

    /**
     * The viewport changed during the choice (window resize, fullscreen toggle): lay the fan out again for the
     * new size, so the cards, the hit-testing and the coming flight all agree with what is on screen.
     */
    _onResize = () => {
        if (this.phase !== "choosing" || !this.rendered) return;
        const L = this.layout = computeLayout(this.count, this.aspect);
        this.stage.style.setProperty("--cp-card-w", `${L.elemW}px`);
        this.stage.style.setProperty("--cp-card-h", `${L.elemH}px`);
        for (const card of this.fanOrder) {
            card.pose = this._fanPose(card.fanIndex);
            this._settle(card);
        }
        this._renderHover(this.hoverIndex, true);
    };

    /**
     * Fan index under a viewport point, from the fan geometry rather than DOM hit-testing: lifted, overlapping
     * cards would otherwise slide out from under the pointer and flicker. A card owns the strip of the fan where
     * its left edge shows (the next card covers the rest), and the last card owns its whole width.
     * @param {number} clientX
     * @param {number} clientY
     * @returns {number} Fan index or -1.
     */
    _indexAt(clientX, clientY) {
        const L = this.layout;
        const n = this.count;
        const px = clientX - window.innerWidth / 2 - L.pivotX;
        const py = clientY - window.innerHeight / 2 - L.pivotY;
        const r = Math.hypot(px, py);
        // Radially: from the cards' far edge (toward the pivot) to the near edge of a pulled-out card.
        if (r < L.radius - L.fanH * 0.55 || r > L.radius + L.fanH * 0.68) return -1;
        const theta = Math.atan2(px, py);
        const halfCard = Math.atan2(L.fanW / 2, L.radius);
        const first = L.fan[0].theta;
        const last = L.fan[n - 1].theta;
        if (theta < first - halfCard || theta > last + halfCard) return -1;
        if (n === 1) return 0;
        const strip = (theta - first + halfCard) / L.step;
        let index = Math.min(n - 1, Math.floor(strip));
        // Hysteresis: keep the current card until the pointer is clearly past its strip.
        const cur = this.hoverIndex;
        if (cur >= 0 && Math.abs(index - cur) === 1 && cur < n - 1) {
            const into = strip - cur;
            if (into > -0.15 && into < 1.15) index = cur;
        }
        return index;
    }

    /** @param {PointerEvent} event */
    _onPointerMove(event) {
        if (this.phase !== "choosing") return;
        this._setLocalHover(this._indexAt(event.clientX, event.clientY));
    }

    /** @param {MouseEvent} event */
    _onClick(event) {
        if (this.phase !== "choosing" || event.button !== 0) return;
        if (event.target.closest("button")) return;
        const index = this._indexAt(event.clientX, event.clientY);
        if (index < 0) return;
        this._lift(index);
        CardPicker.choose(this.session, index);
    }

    /**
     * A hover change made on this client: apply at once, then broadcast (only on change, throttled, with a
     * trailing send so the last value always goes out).
     * @param {number} index
     */
    _setLocalHover(index) {
        if (index === this._localHover || this.phase !== "choosing") return;
        this._localHover = index;
        this._showHover(true);
        clearTimeout(this._hoverSendTimer);
        const wait = HOVER_THROTTLE_MS - (Date.now() - this._lastHoverSent);
        const send = () => {
            this._lastHoverSent = Date.now();
            CardPicker.broadcastHover(this.session, this._localHover);
        };
        if (wait <= 0) send();
        else this._hoverSendTimer = setTimeout(send, wait);
    }

    /**
     * A hover mirrored from another client. Several users may point at the fan at once (the picker and any GM),
     * so each user's hover is kept apart and {@link _showHover} decides which one is shown.
     * @param {number} index   Fan index or -1.
     * @param {string} userId  Whose pointer it is.
     */
    applyHover(index, userId) {
        if (!Number.isInteger(index) || index >= this.count) index = -1;
        this._remoteHovers.set(userId, index);
        if (this.phase === "choosing") this._showHover(false);
    }

    /**
     * Pick the hover to show: this client's own pointer wins while it is on the fan (so the card under the
     * user's cursor is always the lifted one), then the picker's pointer, then a GM's. Without this order a GM
     * idly moving the mouse would yank the lifted card away from under the picker.
     * @param {boolean} local Whether the change comes from this client's own pointer.
     */
    _showHover(local) {
        let index = this._localHover;
        if (index < 0) index = this._remoteHovers.get(this.session.pickerId) ?? -1;
        if (index < 0) index = [...this._remoteHovers.values()].find((i) => i >= 0) ?? -1;
        this._renderHover(index, local);
    }

    /**
     * Show `index` as the hovered card: it lifts toward the viewer while its neighbours give way. Local hovers
     * respond fast; mirrored ones ease over a little longer so throttled updates still glide.
     * @param {number} index  Fan index or -1.
     * @param {boolean} local Whether the hover comes from this client's own pointer.
     */
    _renderHover(index, local) {
        if (this.phase !== "choosing") return;
        const changed = index !== this.hoverIndex;
        this.hoverIndex = index;
        this.stage.style.setProperty("--cp-hover-ms", local ? "150ms" : "300ms");
        this.stage.classList.toggle("cp-has-hover", index >= 0);
        const L = this.layout;
        // Neighbours give way by up to the covered part of the hovered card, fading out over a few cards.
        const giveWay = L.giveWay;
        // The give-way tapers off card by card, but never so fast that a neighbour closes more than half of
        // the gap to the next card: the fan bunches up softly instead of stacking cards on top of each other.
        const taper = Math.min(0.35, (0.5 * L.spacing) / Math.max(1, L.giveWay));
        for (const card of this.fanOrder) {
            const d = card.fanIndex - index;
            // [x, y, z, scale] in the card element's own px; kept on the card so _promote can convert it.
            let v = null;
            // The hovered card slides out of the fan toward the player and a little toward the eye.
            if (index >= 0 && d === 0) v = [0, 0.13 * L.elemH, 0.05 * L.elemH, 1.05];
            else if (index >= 0 && d > 0) v = [giveWay * Math.max(0, 1 - (d - 1) * taper), 0, 0, 1];
            else if (index >= 0) v = [-giveWay * 0.3 * Math.max(0, 1 + (d + 1) * taper), 0, 0, 1];
            this._setHoverOffset(card, v);
            card.el.classList.toggle("cp-hovered", d === 0 && index >= 0);
        }
        if (changed && index >= 0 && Date.now() - this._lastHoverSound > HOVER_SOUND_GAP_MS) {
            this._lastHoverSound = Date.now();
            playPhaseSound(this.session.sounds.hover, this.session.appearance, HOVER_VOLUME);
        }
    }

    /**
     * Lift the chosen card out of the fan and lock the choice. Runs on the clicking client at once (instant
     * feedback) and on everyone else when the reveal arrives.
     * @param {number} index
     */
    _lift(index) {
        if (this.pickedIndex === index) return;
        const L = this.layout;
        // The authority may have accepted a different click than ours (a GM clicked first): drop our lift.
        if (this.pickedIndex >= 0) {
            const old = this.fanOrder[this.pickedIndex];
            this._setHoverOffset(old, null);
            old.el.classList.remove("cp-picked");
        }
        this.phase = this.phase === "choosing" ? "picked" : this.phase;
        this.pickedIndex = index;
        this.stage.classList.remove("cp-interactive", "cp-has-hover");
        this.stage.style.setProperty("--cp-hover-ms", "380ms");
        for (const card of this.fanOrder) {
            card.el.classList.remove("cp-hovered");
            if (card.fanIndex !== index) this._setHoverOffset(card, null);
        }
        const card = this.fanOrder[index];
        this._promote(card);
        card.el.classList.add("cp-picked");
        // Inside the pose's scale, so in the card's own (now full-size) px.
        this._setHoverOffset(card, [0, 0.22 * L.cardH, 0.12 * L.cardH, 1.07]);
        this._liftedAt = performance.now();
        this.caption.classList.remove("cp-visible");
        if (!this._pickSoundPlayed) {
            this._pickSoundPlayed = true;
            playPhaseSound(this.session.sounds.pick, this.session.appearance);
        }
    }

    /**
     * Write a card's hover offset (its slide out of the fan, or its step aside for a neighbour).
     * @param {object} card
     * @param {[number, number, number, number]|null} v  `[x, y, z, scale]` in the element's px, or null for none.
     */
    _setHoverOffset(card, v) {
        card.hoverV = v;
        card.hover.style.transform = v ? `translate3d(${v[0]}px, ${v[1]}px, ${v[2]}px) scale(${v[3]})` : "";
    }

    /**
     * Rebuild a card at the viewer's size without moving it: the element grows to full size and the pose
     * scale shrinks by the same factor, in one frame, so nothing changes on screen except that the card is now
     * rasterized sharply enough to fly up to the viewer. Only ever done for the chosen card.
     * @param {object} card
     */
    _promote(card) {
        if (card.promoted) return;
        card.promoted = true;
        const L = this.layout;
        const k = L.elemH / L.cardH;
        card.el.style.setProperty("--cp-card-w", `${L.cardW}px`);
        card.el.style.setProperty("--cp-card-h", `${L.cardH}px`);
        card.pose = { ...card.pose, sx: card.pose.sx * k, sy: card.pose.sy * k };
        // The hover offset it carries is in px of the old, smaller element: rewrite it in the new px, with the
        // transition off for this one frame so the card doesn't glide between two spellings of the same place.
        card.hover.style.transition = "none";
        const v = card.hoverV;
        this._setHoverOffset(card, v ? [v[0] / k, v[1] / k, v[2] / k, v[3]] : null);
        this._settle(card);
        void card.hover.offsetWidth;
        card.hover.style.transition = "";
    }

    /* ---------------------- reveal ---------------------- */

    /**
     * The authority drew a card: collapse the rest of the fan, fly the chosen card into a hidden viewer, then
     * swap the viewer in on the frame the flight lands, so the reveal continues without a seam.
     * @param {{index:number, card:object}} data  The reveal payload.
     */
    async reveal({ index, card: drawn }) {
        await this._fanReady;
        if (!this.rendered || this.phase === "revealing" || this.phase === "handover") return;
        if (!Number.isInteger(index) || index < 0 || index >= this.count) index = 0;
        this._lift(index);
        this.phase = "revealing";
        this.element.querySelector(".cp-orbs")?.classList.remove("cp-visible");
        const L = this.layout;
        const picked = this.fanOrder[index];

        // The rest of the fan gathers below the chosen card and sinks away, nearest cards first.
        const gather = { x: L.pivotX, y: L.pivotY + L.radius - L.fanH * 0.08 };
        for (const card of this.fanOrder) {
            if (card === picked) continue;
            const d = Math.abs(card.fanIndex - index);
            const delay = 60 + d * Math.min(26, 300 / this.count);
            const g = {
                ...card.pose, x: gather.x, y: gather.y, rz: card.pose.rz * 0.25, lz: card.fanIndex * L.fanGap - 40
            };
            this._animatePose(card, g, { delay, duration: 420, easing: EASE.inOut });
            this._animatePose(card, { ...g, y: g.y + L.vh * 0.75, z: -160, rx: 28 },
                { delay: delay + 340, duration: 560, easing: EASE.fall });
            card.body.animate([{ opacity: 1 }, { opacity: 0 }], { delay: delay + 520, duration: 380, easing: "ease-in", fill: "forwards" });
            card.shade.animate([{ opacity: 1 }, { opacity: 0 }], { delay: delay + 340, duration: 300, fill: "forwards" });
        }

        // Preload both sides of the drawn card, then build the viewer hidden underneath and measure it.
        await Promise.all([loadImage(drawn.front), loadImage(drawn.revealBack)]);
        if (!this.rendered) return;
        const viewer = await new FancyDisplay({
            imgArray: [{ front: drawn.front, back: this.session.back, reversed: !!drawn.reversed }],
            glowColor: this.session.appearance.glowColor,
            glowIntensity: this.session.appearance.glowIntensity,
            faceDown: true,
            sendToChat: false,
            sound: this.session.appearance.sound,
            soundVolume: this.session.appearance.soundVolume,
            soundChannel: this.session.appearance.soundChannel,
            revealDelay: this.session.appearance.revealDelay,
            // Everyone already sees this card: no share button, no chat post of its own.
            isShared: true,
            handover: true,
            revealBack: drawn.revealBack
        }).render(false, true);
        if (!this.rendered) {
            viewer?.close();
            return;
        }
        const target = await viewer?.handoverRect();
        if (!target) {
            // No viewer to hand over to: just leave quietly.
            viewer?.close();
            this.dismiss();
            return;
        }

        // Give the lift a moment to read before the flight takes over.
        const sinceLift = performance.now() - (this._liftedAt ?? 0);
        // A plain timer: it must fire even if the scene closes meanwhile, so the hidden viewer below gets closed.
        if (sinceLift < 300) await new Promise((r) => setTimeout(r, 300 - sinceLift));
        if (!this.rendered) return viewer.close();

        // Flight: pose → the viewer's card rect; the lift unwinds on the same curve; a depth bump in between.
        const flightDur = 950;
        const cx = target.left + target.width / 2 - window.innerWidth / 2;
        const cy = target.top + target.height / 2 - window.innerHeight / 2;
        this._settle(picked);
        const flight = this._animatePose(picked, {
            x: cx, y: cy, z: 0, rx: 0, ry: 0, rz: 0, lx: 0, ly: 0, lz: 0,
            sx: target.width / L.cardW, sy: target.height / L.cardH
        }, { duration: flightDur, easing: EASE.flight });
        picked.hover.style.transition = `transform ${flightDur}ms ${EASE.flight}`;
        picked.hover.style.transform = "";
        picked.flight.animate([
            { transform: "translate3d(0, 0, 0) rotateX(0deg)" },
            // A modest bump: the card is nearly viewer-sized by now, and a deeper one would push it off screen.
            { transform: `translate3d(0, ${-L.vh * 0.02}px, 60px) rotateX(8deg)`, offset: 0.45 },
            { transform: "translate3d(0, 0, 0) rotateX(0deg)" }
        ], { duration: flightDur, easing: "ease-in-out" });
        // Start from whatever the hover/pick state left the glow at, so it never blinks.
        picked.glow.animate([{ opacity: getComputedStyle(picked.glow).opacity }, { opacity: 1 }], { delay: flightDur * 0.35, duration: flightDur * 0.65, easing: "ease-out", fill: "forwards" });
        // The viewer's card carries no sheen: fade it out so the hand-over frame matches pixel for pixel.
        const shine = picked.el.querySelector(".cp-card-shine");
        shine.animate([{ opacity: getComputedStyle(shine).opacity }, { opacity: 0 }], { duration: flightDur * 0.7, easing: "ease-out", fill: "forwards" });
        picked.shade.animate([{ opacity: 1 }, { opacity: 0 }], { delay: flightDur * 0.3, duration: flightDur * 0.7, easing: "ease-out", fill: "forwards" });
        this.phase = "handover";

        try {
            await flight.finished;
        } catch {
            // Cancelled because the scene closed underneath us.
        }
        if (!this.rendered) return viewer.close();

        // Same frame: reveal the viewer (identical backdrop, card at the identical rect) and drop this scene.
        requestAnimationFrame(() => {
            viewer.releaseHandover();
            this.element.style.display = "none";
            this._allowClose = true;
            this.close();
        });
    }

    /**
     * Leave the scene without a reveal (cancel, or the initiating GM disconnected): the fan sinks and fades
     * with the backdrop, then the app closes. Idempotent.
     */
    async dismiss() {
        if (this.phase === "closing" || !this.rendered) return;
        this.phase = "closing";
        // Stop whatever the run-up still had queued (sounds, the spread opening the choice).
        for (const t of this._timers) clearTimeout(t);
        this._timers.clear();
        this.stage.classList.remove("cp-interactive");
        this.caption?.classList.remove("cp-visible");
        const dur = 480;
        this.sceneEl.animate([{ transform: "translate3d(0, 0, 0)" }, { transform: `translate3d(0, ${window.innerHeight * 0.06}px, 0)` }],
            { duration: dur, easing: "ease-in", fill: "forwards" });
        const fade = this.element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur, easing: "ease-in", fill: "forwards" });
        try {
            await fade.finished;
        } catch { /* closed meanwhile */ }
        this._allowClose = true;
        await this.close();
    }
}

/* -------------------------------------------- */
/*  Session control                             */
/* -------------------------------------------- */

/**
 * "Pick a card": a GM starts a shared scene in which one player chooses a card from a face-down fan, then the
 * card is drawn with Foundry's Cards API and revealed through the module's viewer on every client.
 *
 * Sync is deliberately minimal: the initiating GM's client is the only authority (it accepts the first
 * choice, draws the card and announces it); every other client just plays the scene from the start message and
 * reacts to hover / reveal / cancel messages. There is no state recovery for late joiners, and after the reveal
 * no shared state at all: each client's viewer is its own, exactly like a shared `Display`.
 */
export default class CardPicker {
    /**
     * Start a pick. GM only. See docs/API.md for the options.
     * @param {object} [options]
     * @returns {Promise<Array<object>|null>}  One card-data entry (as `Dealer.draw` returns) extended with
     *   `userId` (the picker), `pickedBy` (who clicked) and `index` (the clicked fan position), or null when the
     *   pick was cancelled or could not start.
     */
    static async pick(options = {}) {
        const {
            deckName, deckId, userId, userName, destination, back, maxCards = DEFAULT_MAX_CARDS,
            promptPicker, promptSpectator, promptGM, promptCancel, glowColor, glowIntensity, sound, soundVolume, soundChannel,
            revealDelay, sendToChat, showDescription, reversalChance = 0, sounds = {}
        } = options;

        if (!game.user.isGM) {
            ui.notifications.warn("Only a GM can start a card pick.");
            return null;
        }
        if (scene || authority) {
            ui.notifications.warn("A card pick is already running.");
            return null;
        }

        // Source deck.
        const deck = deckId ? game.cards.get(deckId) : (deckName ? game.cards.getName(deckName) : null);
        if (!deck) {
            ui.notifications.warn(deckId || deckName ? `No deck "${deckId ?? deckName}" was found.` : "Deck name or id not provided.");
            return null;
        }
        const available = deck.availableCards ?? [];
        if (!available.length) {
            ui.notifications.warn(`The deck "${deck.name}" has no cards left to draw. Reset or recall the deck and try again.`);
            return null;
        }

        // Picker: any connected user, GM included.
        const picker = userId ? game.users.get(userId) : (userName ? game.users.getName(userName) : null);
        if (!picker) {
            ui.notifications.warn(userId || userName ? `No user "${userId ?? userName}" was found.` : "No picker given: pass userId or userName.");
            return null;
        }
        if (!picker.active) {
            ui.notifications.warn(`${picker.name} is not connected, so they cannot pick a card.`);
            return null;
        }

        // Destination: explicit, else the picker's Complete Card Management hand, else the deck's discard pile.
        let dest;
        if (destination) {
            dest = resolveStack(destination);
            if (!dest) {
                ui.notifications.warn(`No card stack "${destination}" was found to receive the card.`);
                return null;
            }
        } else {
            dest = resolveStack(foundry.utils.getProperty(picker, "flags.complete-card-management.playerHand"));
            dest ??= await new CardDealer({ deckName: deck.name })._findOrCreatePile(deck);
        }
        if (!dest || dest === deck) {
            ui.notifications.warn("The pick needs a destination stack other than the deck itself.");
            return null;
        }

        // Appearance, resolved here once with the same fallbacks as FancyDisplay#render, and sent resolved so
        // every client shows and plays exactly the same thing.
        const appearanceCfg = game.settings.get(MODULE_ID, SETTINGS.CARD_APPEARANCE);
        const soundCfg = game.settings.get(MODULE_ID, SETTINGS.REVEAL_SOUND);
        const appearance = {
            glowColor: glowColor || appearanceCfg.glowColor,
            glowIntensity: glowIntensity ?? (glowColor ? undefined : appearanceCfg.glowIntensity),
            sound: sound === undefined ? soundCfg.sound : sound,
            soundVolume: soundVolume ?? soundCfg.volume,
            soundChannel: soundChannel ?? soundCfg.channel,
            revealDelay: revealDelay ?? appearanceCfg.dramaticRevealDelay
        };
        const str = (v) => (typeof v === "string" ? v : "");

        const session = {
            sessionId: foundry.utils.randomID(),
            seed: Math.floor(Math.random() * 0xFFFFFFFF),
            pickerId: picker.id,
            gmId: game.user.id,
            count: Math.max(1, Math.min(available.length, Math.floor(Number(maxCards) || DEFAULT_MAX_CARDS))),
            back: back || available[0]?.back?.img || appearanceCfg.backImage,
            prompts: {
                picker: str(promptPicker) || DEFAULT_PROMPTS.picker,
                spectator: str(promptSpectator) || DEFAULT_PROMPTS.spectator,
                gm: str(promptGM) || DEFAULT_PROMPTS.gm,
                cancel: str(promptCancel) || DEFAULT_PROMPTS.cancel
            },
            appearance,
            // Same rule as the reveal `sound`: a path plays that file, "" (or any non-string) is silence, and
            // only a truly absent entry falls back to the bundled sound.
            sounds: Object.fromEntries(Object.entries(DEFAULT_SOUNDS).map(([key, fallback]) =>
                [key, sounds?.[key] === undefined ? fallback : str(sounds[key])]))
        };

        return new Promise((resolve) => {
            authority = {
                sessionId: session.sessionId,
                session,
                deck,
                destination: dest,
                chosen: false,
                resolve,
                dealer: new CardDealer({ deckName: deck.name, reversalChance }),
                sendToChat: resolveSendToChat(sendToChat),
                showDescription: resolveShowDescription(showDescription)
            };
            CardPicker._emit(MSG.START, session);
            CardPicker._openScene(session);
        });
    }

    /**
     * Route a pick message from the module socket. Called from hooks.js for every `pick*` type.
     * @param {string} type
     * @param {object} payload
     */
    static onSocketMessage(type, payload) {
        if (!payload?.sessionId) return;
        switch (type) {
            case MSG.START:
                // This client is running a pick of its own (two GMs started at once): keep it, or its promise and
                // its cancel button would be orphaned by the other GM's scene.
                if (authority) return;
                if (!CardPicker._isSession(payload)) return;
                return CardPicker._openScene(payload);
            case MSG.HOVER:
                if (scene?.sessionId === payload.sessionId) scene.app.applyHover(payload.index, payload.userId);
                return;
            case MSG.CHOOSE:
                return CardPicker._onChoose(payload);
            case MSG.REVEAL:
                if (scene?.sessionId === payload.sessionId) scene.app.reveal(payload);
                return;
            case MSG.CANCEL:
                if (scene?.sessionId === payload.sessionId) scene.app.dismiss();
                return;
        }
    }

    /**
     * Close the scene on every client when the initiating GM drops out before a card was chosen.
     * Wired to the `userConnected` hook in hooks.js.
     * @param {User} user
     * @param {boolean} connected
     */
    static onUserConnected(user, connected) {
        if (connected || !scene || user.id !== scene.gmId) return;
        if (["intro", "choosing", "picked"].includes(scene.app.phase)) scene.app.dismiss();
    }

    /**
     * Esc keybinding: while a scene is on screen before the reveal, cancel it if this client is its initiating
     * GM, and swallow the key on every other client.
     * @returns {boolean} Whether the key was consumed.
     */
    static onEscape() {
        if (!scene || !["intro", "choosing", "picked"].includes(scene.app.phase)) return false;
        // The starting GM cancels; everyone else just has Esc swallowed, so core's dismiss doesn't open the
        // main menu behind the overlay.
        if (authority && !authority.chosen && scene.gmId === game.user.id) CardPicker.cancel(authority.sessionId);
        return true;
    }

    /**
     * Cancel a pick before a card was chosen. Initiating GM only; refused once a choice was accepted.
     * @param {string} sessionId
     */
    static cancel(sessionId) {
        if (!authority || authority.sessionId !== sessionId || authority.chosen) return;
        const { resolve } = authority;
        authority = null;
        CardPicker._emit(MSG.CANCEL, { sessionId });
        if (scene?.sessionId === sessionId) scene.app.dismiss();
        resolve(null);
    }

    /**
     * A local click on the fan: hand it to the authority (directly when this client is the initiating GM).
     * @param {object} session
     * @param {number} index
     */
    static choose(session, index) {
        const payload = { sessionId: session.sessionId, index, userId: game.user.id };
        if (game.user.id === session.gmId) CardPicker._onChoose(payload);
        else CardPicker._emit(MSG.CHOOSE, payload);
    }

    /**
     * Broadcast this client's hover.
     * @param {object} session
     * @param {number} index
     */
    static broadcastHover(session, index) {
        CardPicker._emit(MSG.HOVER, { sessionId: session.sessionId, index, userId: game.user.id });
    }

    /**
     * Authority side of a choice: the first valid one wins, the card is drawn at random from the deck into the
     * destination, and everyone is told which card it was and where it flies from.
     * @param {{sessionId:string, index:number, userId:string}} payload
     */
    static async _onChoose({ sessionId, index, userId } = {}) {
        const auth = authority;
        if (!auth || auth.sessionId !== sessionId || auth.chosen) return;
        const chooser = game.users.get(userId);
        if (!chooser?.active || (chooser.id !== auth.session.pickerId && !chooser.isGM)) return;
        if (!Number.isInteger(index) || index < 0 || index >= auth.session.count) return;
        // Locked before the first await: a second click arriving during the draw is ignored.
        auth.chosen = true;

        // Everything from here to the announcement sits in one try: whatever fails (the draw, a card without a
        // face...), every client is released with a cancel and the promise settles, so a broken card can never
        // leave the table behind an overlay nobody can close.
        let data, payload;
        try {
            const [card] = await auth.destination.draw(auth.deck, 1, { how: CONST.CARD_DRAW_MODES.RANDOM, chatNotification: false });
            if (!card) throw new Error("The draw returned no card.");
            data = auth.dealer._extractCardProperties(card);
            payload = {
                sessionId,
                index,
                chooserId: chooser.id,
                card: {
                    front: data.front,
                    // Reverse side after the first reveal: the card's own back, else the fan back.
                    revealBack: data.back || auth.session.back,
                    reversed: data.reversed
                }
            };
        } catch (error) {
            ui.notifications.error(`Could not draw from the deck "${auth.deck.name}". See the console for details.`);
            console.error(`${MODULE_ID} | Error drawing the picked card.`, error);
            authority = null;
            CardPicker._emit(MSG.CANCEL, { sessionId });
            if (scene?.sessionId === sessionId) scene.app.dismiss();
            auth.resolve(null);
            return;
        }

        authority = null;
        CardPicker._emit(MSG.REVEAL, payload);
        if (scene?.sessionId === sessionId) scene.app.reveal(payload);

        // The chat preview is posted once, by this client, about when the face shows. Like Dealer.draw it runs
        // on a timer of its own, not off this client's viewer, so it is posted even if the GM closes the viewer
        // early or starts the next pick right away.
        if (auth.sendToChat) {
            setTimeout(() => postCardToChat({
                deckName: auth.deck.name, cardId: data.id, cardName: data.name, front: data.front,
                desc: data.desc, reversed: data.reversed, isPublic: true, showDescription: auth.showDescription
            }), REVEAL_LEAD_MS + (auth.session.appearance.revealDelay ?? 0));
        }
        auth.resolve([{ ...data, userId: auth.session.pickerId, pickedBy: chooser.id, index }]);
    }

    /**
     * Open the scene on this client. A scene still on screen from an earlier pick is dropped.
     * @param {object} session  The start payload.
     */
    static _openScene(session) {
        // A viewer still open from an earlier reveal would sit above the scene (and a click outside it would
        // close every viewer, the hand-over one included): close them first.
        CardViewerApp.closeAll();
        if (scene) {
            const old = scene.app;
            scene = null;
            old._allowClose = true;
            old.close();
        }
        const app = new CardPickApp({ session });
        scene = { sessionId: session.sessionId, gmId: session.gmId, pickerId: session.pickerId, app };
        app.render({ force: true });
    }

    /**
     * Shape check of a start payload received from the socket, so a malformed message can never leave this
     * client with a scene that failed to render.
     * @param {object} session
     * @returns {boolean}
     */
    static _isSession(session) {
        return typeof session.back === "string"
            && Number.isInteger(session.count) && session.count > 0
            && Number.isFinite(session.seed)
            && !!game.users.get(session.pickerId) && !!game.users.get(session.gmId)?.isGM
            && typeof session.prompts?.picker === "string" && typeof session.prompts?.spectator === "string"
            && !!session.appearance && !!session.sounds;
    }

    /**
     * @param {string} type
     * @param {object} payload
     */
    static _emit(type, payload) {
        game.socket.emit(SOCKET_EVENT, { type, payload });
    }
}

export { CardPickApp };
