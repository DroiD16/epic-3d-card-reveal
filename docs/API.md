# Epic 3D Card Reveal — API Reference

The API is exposed under the global `EpicCards` namespace, which mirrors `game.modules.get('epic-3d-card-reveal').api`. Either entry point can be used interchangeably from macros and other modules.

The global is assigned during the `ready` hook; the API object itself exists from `setup` onward.

## Sharing & chat behavior

- **Any user can share.** The share (eye) button in the viewer is available to players and GMs alike. It is hidden only when the card is already being broadcast to everyone (sharing again would be pointless).
- **Revealing a card posts a clickable chat message** (when `sendToChat` is on — see below). Clicking the thumbnail in that message re-opens the card/image locally, which is handy when a card is closed by accident. Public posts go to everyone; non-public posts are whispered to the GM.
- This applies to every flow: deck/sidebar clicks, `Dealer.draw`, `Dealer.view`, **and** arbitrary `Display` images (the message carries the image itself so it can be re-opened with no backing Card document).
- Re-opening a card from a chat thumbnail never posts a second message.
- **All chat messages share one card style** (accent border, dark header, no background image), produced by a single `buildChatCard` helper.

### Card descriptions

A **Send card description to chat** world setting (Configure Settings → Module Settings) adds the card's description to the chat preview. It is **off by default**, so existing previews (image + name only) are unchanged until you enable it.

- The text comes from the **Card document's own description** field — the same place lore decks such as the **PF2e Harrow Deck** store their card text. (It is not the per-face text.)
- The description is **enriched** before posting (`TextEditor.enrichHTML`), so `@UUID` links, formatting, and inline rolls render instead of appearing as raw markup.
- Only **deck cards** can carry a description. Cards with an empty description, and arbitrary images shown through `Display` (which have no backing Card document), post exactly as they do today.
- The setting is the default for every chat path (deck/sidebar clicks, `Dealer.draw`, `Dealer.view`). `Dealer.draw` and `Dealer.view` accept an optional **`showDescription`** boolean that overrides it per call (omit to follow the world default); the macro builder bakes this choice for deck macros (see below).

### `sendToChat`

Every entry point accepts an optional `sendToChat` boolean.

- **Default:** the **Send revealed cards to chat** world setting (Configure Settings → Module Settings), which ships enabled.
- **Override:** pass `sendToChat: true`/`false` per call to force the behavior regardless of the setting.
- The macro builder exposes this as a **Send to chat** toggle (Appearance tab), seeded from the world default, and bakes the chosen value into the generated macro.
- The chat preview is posted **the moment the card's face is revealed**, never before — so it can't spoil a hidden card. A **face-up** card posts immediately; a **face-down** card posts when you flip it face-up (close it without flipping and nothing is posted); a **dramatic reveal** posts when the cards auto-flip after the delay. This mirrors the [reveal sound](#reveal-sound).

Cross-client sharing uses Foundry's native socket API (`module.epic-3d-card-reveal` channel); no socketlib dependency.

## Appearance defaults

Glow color/intensity, the default card back image, and the dramatic reveal delay come from the **Configure Card Appearance** settings menu (stored in the hidden `cardAppearance` world setting, a `DataModel`). Every visual option below overrides those defaults per call.

The glow is controlled by two values: **Glow color** (the hue, defaulting to gold) and **Glow intensity** (a `0`–`1` strength). At `0` the glow is off; the rest of the slider is a usable band with no dead zone — the default already gives a strong glow, and the top of the slider pushes it brighter and wider still.

## Reveal sound

A sound can play when a card's **face** is revealed.

- **Plays only when the face is seen.** A card shown face-up plays the sound immediately; a card shown face-down (or in a dramatic reveal) plays it the moment it is flipped/auto-flipped face-up — never while only the back is showing.
- **Plays once per viewer.** Flipping a card back and forth won't replay it.
- **Local to the viewing client.** Each client that sees the card plays the sound on its own audio device — nothing is streamed between clients. When a card is shared, everyone viewing it hears it locally.

Defaults come from the **Configure Reveal Sound** settings menu (GM-only, under Configure Settings → Module Settings), stored in the hidden `revealSound` world setting (a `DataModel`):

| Field | Description |
|---|---|
| **Reveal sound** | Audio file to play. Ships with `assets/reveal.ogg`. **Leave blank for no sound.** |
| **Reveal sound volume** | Playback volume, `0`–`1`. The chosen channel's mixer volume still applies on top. |
| **Audio channel** | Which audio channel / mixer slider the sound plays through: `interface`, `music`, or `environment`. |

The menu includes a **Reset to Defaults** button that restores the shipped sound, volume, and channel.

Every entry point can override these per call with `sound`, `soundVolume`, and `soundChannel` (see the option tables below). For `sound`:

- **omit it** → use the world default reveal sound;
- **a file path** → play that sound;
- **`""` (empty string)** → play **no sound** for this call, regardless of the world default.

`soundVolume` and `soundChannel` fall back to the world default whenever omitted. The macro builder exposes all of this as a **Reveal sound** control (Appearance tab) with three modes — *Use module default*, *Custom sound* (file + volume + channel), and *No sound* — and bakes the result into the generated macro.

## Reversed cards (Tarot-style)

Every entry point accepts an optional `reversalChance` (`0`–`100`): the percent chance that each card it shows is rendered **upside-down** (rotated 180°), the way a Tarot reading distinguishes a reversed card.

- **Off by default.** `reversalChance` defaults to `0`, so nothing is reversed unless you ask for it. `50` gives each card a coin-flip; `100` reverses every card.
- **Per card.** With multiple cards, each one rolls independently.
- **Re-rolled on every display.** The orientation is **not** stored on the card — drawing or viewing the same card again rolls afresh. Because it lives nowhere on the Card document, the only way to read it from outside is the `reversed` field on what [`Dealer.draw`](#drawoptions) / [`Dealer.view`](#viewcards-facedown-dramaticreveal-share-options) return. Anything you persist from it (a rotation on a scene card, say) is your own copy and won't follow a later re-roll.
- **Text is never changed.** Only the *visual* is flipped; the card's chat description is posted exactly as written, matching real Tarot practice where the reversed meaning is inferred by the reader. The chat thumbnail mirrors the orientation and is tagged **"Reversed"**.
- **Consistent across the table and on re-open.** The roll happens once on the client that triggers the display, so every player who is shown the card sees the same orientation. The orientation is stored on the chat message, so clicking the thumbnail re-opens the card the same way up it was published.
- The macro builder exposes this as a **Reversed chance** slider (Appearance tab); leaving it at `0` bakes nothing into the generated macro.

---

## `EpicCards.Display(options)`

Construct a card-display instance for any image.

### Options
| Option | Type | Description |
|---|---|---|
| `front` | `string` | Image path or URL. Best with card-shaped images. |
| `back` | `string` (optional) | Back-image path. Falls back to the configured default card back. |
| `glowColor` | `string` (optional) | Card glow color — the hue of the halo around the card (any CSS color). Omit to use the world default. |
| `glowIntensity` | `number` (optional) | Glow strength, `0`–`1`. `0` turns the glow off; higher is brighter/wider. Omit to use the world default. When omitted but a raw `glowColor` (with its own alpha) is given, that color is used as-is. |
| `faceDown` | `boolean` (optional) | Render face-down initially. Default `true`. |
| `sendToChat` | `boolean` (optional) | Post a clickable chat message that re-opens this image. Omit to use the world default. |
| `sound` | `string` (optional) | Reveal-sound override. A path plays that sound; `""` forces no sound; omit to use the world default. See [Reveal sound](#reveal-sound). |
| `soundVolume` | `number` (optional) | Reveal-sound volume (`0`–`1`). Omit to use the world default. |
| `soundChannel` | `string` (optional) | Reveal-sound channel: `interface`, `music`, or `environment`. Omit to use the world default. |
| `revealDelay` | `number` (optional) | Dramatic-reveal delay in ms, overriding the world default. Applies only when rendered with `dramaticReveal`. |
| `reversalChance` | `number` (optional) | `0`–`100` chance that each image is shown upside-down (Tarot-style). `0` (default) disables it; re-rolled per display. See [Reversed cards](#reversed-cards-tarot-style). |

### Returns
An instance with a `.render(shareToAll, dramaticReveal)` method.

- `shareToAll` `{boolean}` — broadcast the view to all connected clients. Default `false`.
- `dramaticReveal` `{boolean}` — render face-down first, then auto-flip after the configured delay (`revealDelay`, or the world default). The card **cannot be clicked to flip early** — it must wait out the delay — and when shared, every client waits out the same reveal together. Default `false`.

### Example
```js
const myViewer = EpicCards.Display({
    front: 'https://i.imgur.com/someAmazingCardFrontImage.jpg',
    back: 'https://i.imgur.com/someAmazingCardBackImage.jpg',
    glowColor: 'rgba(200,200,255,0.4)',
    faceDown: false
});

// ...later
myViewer.render(true);
```

---

## `EpicCards.Dealer(options)`

The viewer's primary job is to show an image with the animated 3D presentation — and `Display` covers that for any arbitrary image. `Dealer` is the optional **card-logic assistant** layered on top: it ties Foundry's `Cards` API (drawing into a discard pile, finding a card across stacks) to that same viewer, so a macro or module can mutate card state **and** show the animated card in a single step instead of re-implementing the deck/pile plumbing.

Construct a dealer bound to a named deck (and, optionally, a named discard pile).

### Options
| Option | Type | Description |
|---|---|---|
| `deckName` | `string` | Name of the source `Cards` deck. |
| `discardPileName` | `string` (optional) | Name of the discard pile to draw into. Created by that name if it doesn't exist. If omitted, the dealer uses the deck's own pile: it creates `"<deckName> - Discard Pile"` on the first draw, links it to the deck with a flag, and reuses it on every later draw — renaming the deck or the pile keeps the link. For players, see [Who creates the discard pile](#who-creates-the-discard-pile). |
| `glowColor` | `string` (optional) | Glow color (hue) for every card this dealer shows. Omit to use the world default. |
| `glowIntensity` | `number` (optional) | Glow strength (`0`–`1`) for every card this dealer shows; `0` turns the glow off. Omit to use the world default. |
| `sound` | `string` (optional) | Reveal-sound override applied to every card this dealer shows. A path plays that sound; `""` forces no sound; omit to use the world default. See [Reveal sound](#reveal-sound). |
| `soundVolume` | `number` (optional) | Reveal-sound volume (`0`–`1`). Omit to use the world default. |
| `soundChannel` | `string` (optional) | Reveal-sound channel: `interface`, `music`, or `environment`. Omit to use the world default. |
| `revealDelay` | `number` (optional) | Dramatic-reveal delay in ms for every card this dealer shows, overriding the world default. Applies only to dramatic-reveal draws/views. |
| `reversalChance` | `number` (optional) | `0`–`100` chance that each card this dealer shows is upside-down (Tarot-style). `0` (default) disables it; re-rolled per display. See [Reversed cards](#reversed-cards-tarot-style). |

The constructor looks nothing up. Each `.draw()` finds the deck and the pile by name when it runs, so you can call it immediately after construction, and a dealer never holds a stale reference.

### Returns
A `CardDealer` instance with `.draw(options)` and `.view(cards, faceDown, dramaticReveal, share)` methods.

#### `.draw(options)`
Draws random cards from the deck into the discard pile, displays them in the viewer, and posts the usual chat preview once the cards are revealed (public when shared, otherwise a GM whisper). See [`sendToChat`](#sendtochat) for the exact post timing of face-down/dramatic draws.

| Option | Type | Description |
|---|---|---|
| `quantity` | `number` (optional) | How many cards to draw. Default `1`. |
| `share` | `boolean` (optional) | Broadcast the view to all clients. Default `true`. |
| `face` | `"up"\|"down"\|"reveal"` (optional) | Force the initial face, overriding each card's source face. `"reveal"` renders face-down then auto-flips after the dramatic-reveal delay, and cannot be clicked open early. |
| `sendToChat` | `boolean` (optional) | Post a clickable chat message that re-opens each card. Omit to use the world default. |
| `showDescription` | `boolean` (optional) | Include the card's description in the chat message. Omit to use the world default ([Card descriptions](#card-descriptions)). |

**Returns** `Promise<Array<CardData>|null>` — the [card data](#card-data) of every card drawn, or `null` if nothing was drawn (empty deck, unknown deck, no GM connected to create a player's pile, or a draw failure — each already warns the user).

#### Who creates the discard pile

Creating a card stack needs Foundry's **Create Card Stacks** permission, which players don't have by default. Drawing cards into a pile needs nothing extra. So when a user without that permission draws and the pile doesn't exist yet, the dealer asks the connected GM's client to create it, then draws as usual. The pile is the same one a GM's draw would create, with the same name and the same link to the deck.

- If no GM is connected, the draw shows a warning and returns `null`. Once the pile exists, players can draw without a GM online.
- GMs, Assistants, and any role you've granted the permission create the pile themselves.
- The pile keeps Foundry's default ownership, so players can draw into it without being able to open it.
- When the GM creates a named pile for a player, the "Creating a new discard pile by that name" notice shows on the GM's screen, not the player's.

#### `.view(cards, faceDown, dramaticReveal, share, options)`
Displays one or more **existing** cards (no draw side effect) and posts the chat preview once the cards are revealed (see [`sendToChat`](#sendtochat) for the timing of face-down/dramatic views).

| Param | Type | Description |
|---|---|---|
| `cards` | `string \| string[]` | Card ID(s) or name(s), searched across every stack in the world. |
| `faceDown` | `boolean` | Render face-down initially. |
| `dramaticReveal` | `boolean` | Render face-down, then auto-flip after the configured delay; the card cannot be clicked open early. |
| `share` | `boolean` | Broadcast the view to all clients. |
| `options` | `object` (optional) | `{ sendToChat, showDescription }` — post a clickable chat message that re-opens each card, and whether that message includes the card's description. Omit either to use its world default. |

**Returns** `Promise<Array<CardData>|null>` — the [card data](#card-data) of every card shown, or `null` if none of the given IDs/names resolved. Cards that aren't found are warned about individually and left out of the array.

### Card data

Both `.draw()` and `.view()` resolve to an array with one entry per card:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | The Card document's id **in the stack it currently sits in**. After a draw that's the discard pile, not the deck. |
| `uuid` | `string` | The Card's full UUID. Use `fromUuid(uuid)` to get the document back wherever it ended up — this is the field to hand to other modules. |
| `name` | `string` | The card's face name. |
| `front` | `string` | Face image path. |
| `back` | `string` | Back image path, as stored on the card. Empty when the card has none; the viewer substitutes the configured default back, but that substitution is **not** reflected here. |
| `desc` | `string` | The Card document's own description, raw (not enriched). See [Card descriptions](#card-descriptions). |
| `reversed` | `boolean` | Whether this card was shown upside-down. See [Reversed cards](#reversed-cards-tarot-style). |

**When it resolves.** The promise settles once the cards have been drawn (or resolved) and the viewer has been *launched* — **not** when the reveal animation ends. Waiting for the flip isn't necessary: `reversed` is rolled before the viewer opens, so the data is already final. A face-down or dramatic-reveal card will still be mid-reveal when you get the array.

The entries are copies, so you can mutate them freely without touching the open viewer.

### Example: integrating with another module

Draw, reveal, and then place the same cards elsewhere with the orientation the table just saw:

```js
const drawn = await EpicCards.Dealer({ deckName: 'Tarot', reversalChance: 50 })
    .draw({ quantity: 3, share: true });

for (const c of drawn ?? []) {
    const card = await fromUuid(c.uuid);
    const rotation = c.reversed ? 180 : 0;
    // ...hand `card` and `rotation` to whatever places it (a scene card layer, a custom sheet, ...).
}
```

### Example
```js
// Draw 3 cards into the discard pile and show them to everyone.
EpicCards.Dealer({
    deckName: 'Deck of Many Things',
    discardPileName: 'Deck of Many Things - Discard Pile'
}).draw({ quantity: 3, share: true });

// Or just re-display an existing card by name, dramatic reveal, GM-only.
EpicCards.Dealer({ deckName: 'Deck of Many Things' })
    .view('The Void', true, true, false);
```

---

## `EpicCards.Pick(options)`

A shared "pick a card" scene. Every connected client sees a face-down deck shuffled and spread into a fan; one user (the **picker**) chooses a card with the mouse while everyone else watches the hover; the chosen card flies to the center and goes through the usual [dramatic reveal](#epiccardsdisplayoptions) in the 3D viewer.

**GM only.** Which card is drawn is decided at the click, not before: the GM client that started the pick draws **one random card** from the deck into the destination stack with Foundry's Cards API, then tells every client which card it was. The clicked position only decides where the card flies from. No client learns a card face before that.

### How the scene behaves

- **Run-up (about 4–5 s).** The deck rises out of the dark, is riffle-shuffled twice, and spreads into a fan, backs up. The shuffle is built from a random seed in the start message, so every client sees the same shuffle.
- **Choosing.** The picker hovers the fan and the card under the pointer lifts while its neighbours give way. The hover is mirrored on every other client. **Any GM** can also hover and click; a GM click picks the card on the player's behalf. Everyone else can only watch. When several pointers are on the fan at once, each client shows its own pointer's card first, then the picker's, then a GM's, so the card under your own cursor is always the one that lifts.
- **Reveal.** The first click the starting GM receives wins. The rest of the fan collapses and sinks away, and the chosen card flies into the viewer and becomes the viewer's card. From there it's the normal dramatic reveal: the card waits out `revealDelay`, flips to its face, plays the reveal sound, and gets the glow, sparkles, cursor tilt and glint.
- **After the reveal** each client is on its own, exactly as with a shared `Display`. Clicking the card flips it, and clicking outside closes the viewer on that client only.
- **Reverse side.** In the fan the cards show the `back` image. After the first reveal, flipping the card shows the card's **own Foundry back** (`card.back.img`) instead, falling back to the fan image when the card has none. Decks whose card backs hold text (a rules side) read naturally this way.
- **Cancel.** The GM who started the pick can cancel before a card is chosen, with the **✕** button or **Esc**. The scene closes on every client, nothing is drawn, and the promise resolves `null`. Players can't close the scene before the reveal. Esc is a regular keybinding (*Cancel card pick*, Configure Controls). It cancels only on the GM who started the pick; on other clients it does nothing while the scene is up.
- **Disconnects.** If the starting GM disconnects during the choice, the scene closes on every client. Users who weren't connected when the pick started don't see it; there is no rejoin.
- **One at a time.** Calling `Pick` while a pick is running warns and resolves `null`. With several GMs, a GM who is running a pick ignores a pick started by another GM at the same moment.
- **Window resize.** The fan is laid out again if the window is resized during the choice.

### Options
| Option | Type | Description |
|---|---|---|
| `deckName` / `deckId` | `string` | The source `Cards` deck, by name or id. Warns and resolves `null` when the deck has no cards left to draw. |
| `userId` / `userName` | `string` | The picker, by id or name. Any connected user, a GM included. Warns and resolves `null` when that user isn't connected. |
| `destination` | `string` (optional) | The `Cards` stack that receives the drawn card: id, name or uuid. When omitted: the picker's hand from the **Complete Card Management** user flag `flags["complete-card-management"].playerHand` (id or uuid) if set, otherwise the deck's own discard pile, found or created the same way as [`Dealer.draw`](#drawoptions) does it. |
| `openDestination` | `boolean` (optional) | Open the destination stack's sheet on the picker's own client as the card is revealed (underneath the viewer, so the card is waiting there when the player dismisses it). Useful for hands that don't open by themselves, such as a docked hand strip. Only if the picker can see that stack. Default `false`. |
| `back` | `string` (optional) | Image of the face-down cards in the deck and fan. Default: the `back.img` of the first card left in the deck, then the configured default card back. Pass the deck's own image (`deck.img`) when that is your card back. The cards keep this image's aspect ratio. |
| `maxCards` | `number` (optional) | Cap on the number of cards in the fan. Default `24`. The fan shows `min(cards left in the deck, maxCards)`. The fan resizes to fit the screen at any count: past two dozen cards the arc stops widening and the cards overlap more. |
| `promptPicker` | `string` (optional) | Caption shown to the picker during the choice. Default `"Pick a card"`. |
| `promptSpectator` | `string` (optional) | Caption shown to everyone else. `{name}` is replaced by the picker's name. Default `"{name} is picking a card…"`. |
| `promptGM` | `string` (optional) | Hint under the caption on a GM's screen (when the GM is not the picker). `{name}` is replaced by the picker's name. Default `"Click a card to pick it for {name}"`. |
| `promptCancel` | `string` (optional) | Hint shown to the GM who started the pick. Default `"Esc or ✕ to cancel"`. |
| `glowColor`, `glowIntensity` | (optional) | The viewer's glow, as for `Display`. The flying card takes on the same glow as it lands. |
| `sound`, `soundVolume`, `soundChannel` | (optional) | The reveal sound, as for `Display`. See [Reveal sound](#reveal-sound). |
| `revealDelay` | `number` (optional) | Wait before the landed card flips face up, in ms. Omit to use the world default. |
| `sendToChat` | `boolean` (optional) | Post the revealed card to chat publicly about when it flips face up (once, from the GM's client, on a timer like `Dealer.draw`, so it is posted even if the GM closes the viewer early). Omit to use the world default. |
| `showDescription` | `boolean` (optional) | Include the card's description in that chat message. Omit to use the world default. |
| `reversalChance` | `number` (optional) | `0`–`100` chance that the card is shown upside-down. See [Reversed cards](#reversed-cards-tarot-style). |
| `sounds` | `object` (optional) | Sounds of the new phases: `{ shuffle, fan, hover, pick }`, each an audio path. Each plays locally on every client at its moment: `shuffle` once per riffle as the cards fall, `fan` when the deck spreads, `hover` when the hovered card changes (rate-limited, played quieter), `pick` when the chosen card lifts out of the fan. Same rule as `sound`: a path plays that file, `""` forces silence, and an omitted entry uses the bundled sound (`assets/pick-*.ogg`, from Kenney's CC0 "Casino Audio" pack). They use the reveal sound's volume and channel. |

### Returns
`Promise<Array<CardData>|null>`. It resolves with one [card data](#card-data) entry, the drawn card exactly as `Dealer.draw` returns it, with three extra fields:

| Field | Type | Description |
|---|---|---|
| `userId` | `string` | The picker's user id. |
| `pickedBy` | `string` | Id of the user whose click was accepted: the picker, or a GM who picked for them. |
| `index` | `number` | The clicked position in the fan, from `0` on the left. |

It resolves `null` when the pick was cancelled, couldn't start (see the warnings above), or the draw failed. It resolves right after the draw, while the card is still flying and before the reveal animation ends, just like `Dealer.draw`.

### Example
```js
const deck = game.cards.getName('Stress deck');
const [card] = await EpicCards.Pick({
    deckName: deck.name,
    userName: 'Player',
    destination: 'Stress: Player',   // optional
    back: deck.img,                  // the deck image is the card back
    promptPicker: 'Draw your fate',
    promptSpectator: '{name} is drawing…'
}) ?? [];
if (card) console.log(`${card.name} went to the hand`, card.uuid);
```

---

# Macro builder

Prefer not to write macros by hand? The module ships a fill-in **macro builder** that turns a few fields into a ready-to-run script macro (display an image, draw from a deck, or view a specific card). Open it either way:

- **`EpicCards.MacroBuilder()`** from a macro or the console, or
- the **Open Macro Builder** button under Configure Settings → Module Settings.

Both open the same form and are GM-only. Generated macros land in the `3D Card Macros` folder.

The Appearance tab also exposes the **Dramatic reveal** toggle; enabling it forces **Start face-down** on and reveals a **Dramatic reveal delay (ms)** field (seeded from the world default), baked into the generated macro as `revealDelay`. During a dramatic reveal the card cannot be clicked open early — every viewer waits out the delay — and the wait is synchronized to all players when the card is shared.

The Appearance tab's **Reversed chance** slider sets `reversalChance` (`0`–`100`) on the generated macro; left at `0` it bakes nothing, so cards are never reversed unless you raise it. See [Reversed cards](#reversed-cards-tarot-style).

The Appearance tab also shows a **Send card description** toggle, but only for the deck-backed macro types (**Draw from a deck** and **View specific cards**) — Display-image macros have no card description, so it is hidden for them. It is seeded from the world setting and baked onto the generated macro as `showDescription`. See [Card descriptions](#card-descriptions).

# Macro example

Want to write one by hand instead? The module ships **no compendium packs** — no macros, decks, or anything else. The only place generated macros live is the `3D Card Macros` folder the macro builder creates in your world's Macro directory. To write one yourself, just copy a snippet below straight into a world macro.

## View any image as a card

```js
const img = 'modules/epic-3d-card-reveal/assets/demo-card-back.webp';
const backImg = 'https://i.imgur.com/mStOCso.png'; // optional
const glowColor = 'rgba(200,200,255,0.4)';         // optional
const shareToAll = true;                           // optional

EpicCards.Display({
   front: img,
   back: backImg,
   glowColor,
   // Reveal-sound overrides are optional. Omit them to use the world default,
   // pass a path for a custom sound, or pass sound: "" for no sound.
   // sound: 'modules/epic-3d-card-reveal/assets/reveal.ogg',
   // soundVolume: 0.8,
   // soundChannel: 'interface'
}).render(shareToAll);
```

## Draw a card from a deck (with card logic)

Use `Dealer` when you also want the draw recorded in Foundry — the card moves from the deck into the discard pile, and the same draw shows up in the 3D viewer.

```js
const deckName = 'Deck of Many Things'; // a Cards deck in your world
const discardPileName = undefined;      // optional; omit to use the deck's own pile
const quantity = 1;                     // optional
const share = true;                     // optional

EpicCards.Dealer({ deckName, discardPileName }).draw({ quantity, share });
```
