# Operation Dustline

A realistic military first-person shooter that runs in your web browser. It has a five-mission
**[story campaign](#campaign)** and a **COMBAT** mode where you take one of three maps from enemy
soldiers, then hold it against waves of counterattacks. Play alone, or
[co-op with up to three friends](#co-op-play-with-friends): the campaign works in co-op too, with
squad voice chat.

It uses photo-scanned materials, real HDR skies, physically based lighting, an animated soldier
model, instanced vegetation and post-processing effects. All the code is commented for learning;
see [LEARNING.md](LEARNING.md).

## Run it

You need [Node.js](https://nodejs.org) 18 or newer and git.

```bash
git clone https://github.com/Josh221/fps_game.git
cd fps_game
npm install       # one-time: the WebSocket library the co-op server uses
npm run assets    # one-time: downloads the textures, models, skies and soldiers into assets/
npm start         # starts server/server.mjs on port 8000
```

Open **http://localhost:8000** in Chrome, Safari or Firefox. The menu has two tabs:
- **CAMPAIGN**: pick a mission, press **BRIEFING**, read it, then **DEPLOY**.
- **COMBAT**: pick a map, a difficulty and a mission length, then click **PLAY SOLO**.

**Esc** pauses; **EXIT TO MENU** takes you back to change mission, map or settings. Headphones are recommended. Three.js and the tree generator load from a CDN, so you need
internet access. (`npm run solo` still serves the game with Python, but without co-op: the menu
says so.)

## Campaign

**OPERATION DUSTLINE.** The Corran Valley has been under a ceasefire for eight months: dry hills in
the south, pine forest in the north, and the market town of Mereth in between. Corvane Security,
the private army hired to guard the valley's mines, has started taking what it was paid to protect.
You are **SABRE**, the ceasefire force's quick-reaction squad. On the radio: **Shepherd** (Maj.
Nadia Rourke, operations), **Raven** (Lt. Tomas Vey, drone operator), and later **Dr. Elise Marr**,
the ceasefire inspector, and **Warden** (Silas Kade, Corvane's field commander).

| # | Mission | Map | What you do |
|---|---|---|---|
| 1 | **Ghost Walk** | Pinewood, dawn fog | Recon. Sneak up the ridge, observe the firebase (aim down your sights at the marked targets), ambush a courier, take his satchel, get out. |
| 2 | **Market Day** | Old Town, afternoon | Rescue. Take the checkpoint, find the safehouse, cut Dr. Marr free and escort her to the trucks, then hold the road. |
| 3 | **Dustline** | Dustline, noon | Raid. Get inside the walls, take the HQ, guard the laptop while it downloads the evidence, blow up the weapons cache. |
| 4 | **High Ground** | Pinewood | Assault. Take the outposts, break into the firebase, destroy the radio jammer (your radio is broken up until you do), then hold the hill. |
| 5 | **Last Light** | Old Town, dusk | Finale. Fight through the town, capture Kade (wound him and he gives up; hold **F** to restrain him), hold the square. |

**How it plays:**
- **Objectives** are listed top left. Gold **markers** on screen and on the minimap show where to
  go; when one is off screen it sits at the edge and points the way.
- **Hold F** to use things: plant a charge, start a download, cut someone free, take a satchel.
  **Aim down your sights** at a marked target to observe it.
- **Radio**: calls from HQ and the drone operator, with subtitles and spoken voices (the browser's
  built-in text-to-speech). Turn the voices off under **Radio voices** on the menu.
- **Checkpoints**: each objective is a checkpoint. If you die (or the person you're escorting is
  killed), **RETRY FROM CHECKPOINT** restarts that objective. In co-op, if the whole squad goes
  down, everyone is put back at the checkpoint after a few seconds.
- **Stars**: 1 for finishing, plus 1 for each **bonus goal** (stay hidden, nobody killed, finish
  quickly, take Kade alive...). Your best result is kept, and finishing a mission unlocks the next.
  Progress is saved in your browser.
- **Difficulty** changes enemy accuracy, damage and numbers, as in COMBAT. Bigger squads face more
  enemies.

**Co-op campaign:** in the lobby the host sets **Mode** to Campaign and picks the **Mission** (from
the missions the host has unlocked). Everyone can press **READ THE BRIEFING** in the lobby, and talk
it over on voice chat before the host starts. After a win, the lobby shows the debrief and the host
gets a **NEXT MISSION** button. Everyone in the squad gets the stars and the unlock.

## Co-op: play with friends

Up to 4 players fight the AI together. Everyone meets in a **lobby** first.

1. **Host:** run `npm start`, type a callsign on the menu and press **HOST GAME**. The lobby shows a
   4-letter room code and an invite link to send your friends.
2. **Friends** can join in three ways:
   - open the invite link;
   - pick your game from **Open games** on the menu;
   - type the code and press **JOIN**.
3. **In the lobby:**
   - The host picks the **mode**: **Campaign** (a story **mission**; it decides the map) or
     **Combat** (a **map** and a **mission length**: 5 waves, 10 waves or endless). Then the
     **difficulty** (Recruit / Regular / Veteran) and **enemy radar** (see Tactical features).
     Everyone gets the same settings: friends see them in the lobby but can't change them.
   - Friends press **READY UP**.
   - Everyone can chat. The squad list shows each player's ping, and the host can remove a player
     with ✕.
4. The host presses **START MISSION**. After a 3-second countdown, the host and everyone who's ready
   deploy. Anyone who wasn't ready can press **JOIN MISSION** later.
5. When the mission ends, everyone returns to the lobby. It ends when you survive every wave, when
   the whole squad is down, or when the host chooses END MISSION. The lobby then shows an
   **after-action report**: kills, deaths, headshots and accuracy for each player. Change the
   settings and go again.

How it plays:

- The lobby's squad list shows each player's **class and main weapon** (e.g. "Marksman · 7.62 DMR"),
  and so does the scoreboard. Change yours with **LOADOUT**.
- Squadmates wear a blue-grey uniform and have a **name tag** you can see through walls. The squad's
  health is listed under the objective.
- **Chat** is in three places: the lobby, the pause menu (Esc), and in-game (press **Enter** or
  **Y**, type, press Enter; Esc cancels). **Tab** shows the scoreboard.
- Downed players **respawn after 10 seconds** at the start point, as long as someone is still up.
- Waves get bigger for bigger squads: each extra player adds 35% more enemies.
- There's no friendly fire. **Esc doesn't pause the game** in co-op, because your squad is still
  fighting. The pause menu has **BACK TO LOBBY** and **LEAVE GAME**. For the host, BACK TO LOBBY
  becomes **END MISSION · BACK TO LOBBY**: it ends the mission for everyone, so you can change the
  map or settings and start again. A friend's BACK TO LOBBY lets the mission carry on; they can
  press JOIN MISSION to get back in.
- **Try co-op on your own:** open the game in a normal window and a private (incognito) window, then
  host in one and join from the other. Each window is a separate player.
- **Refreshing or losing Wi-Fi is fine.** You get your slot back if you return within a minute; the
  game reconnects by itself. When the host changes map, everyone's page reloads into the new map.
- The host's computer runs the enemy AI, so the host should have the fastest computer. Keep the
  host's game tab open. If it's minimised, the game keeps running but stops drawing. If the host
  disconnects mid-mission, the mission ends.

**Voice chat:**

- In the lobby (or the pause menu), press **MIC OFF** to switch your microphone on; the browser asks
  for permission the first time. Then **hold B to talk**, or pick **Open mic**.
- Everyone can hear without a microphone. The squad list shows 🎙 (mic on) and 🔊 (talking). In game
  you get a 🔊 on name tags and **● TRANSMITTING** while you talk. **MUTE** silences someone, just for
  you.
- **Browsers only allow a microphone on `localhost` or `https://` pages.** So `npm start` also serves
  the game over HTTPS on port **8443**, using a certificate it makes for itself (in `.certs/`, which
  needs `openssl`). The invite link uses that address. Friends' browsers say "not private" the first
  time: it's your own certificate, so they click **Advanced → Proceed** (Chrome) or **Show Details →
  visit this website** (Safari). Friends who open the plain `http://` address can listen but not
  talk.
- Voice goes directly between browsers (WebRTC), not through your server. On some strict networks
  (some offices and mobile hotspots) the direct link can't be made. A tunnel with HTTPS
  (cloudflared, ngrok) avoids the browser warning, but not that limit: for that the server needs a
  **voice relay** (see Hosting publicly).

**Where your friends are:**

| Situation | What to do |
|---|---|
| Same Wi-Fi / home network | `npm start` prints a "Friends on your network" address. The invite link already uses it. If friends can't connect, let Node through your computer's firewall (macOS: System Settings → Network → Firewall; Windows asks the first time you run `npm start`). |
| Over the internet, quick | Run a tunnel that forwards a public address to port 8000, such as `cloudflared tunnel --url http://localhost:8000` (Cloudflare) or ngrok. Open the game through the tunnel address yourself too, so the invite link uses it. Every friend downloads the textures through your home upload, so the first load is slow. |
| Over the internet, private | A mesh VPN like Tailscale puts your friends on a private network with you, so they can use your Tailscale address and port 8000. |
| Always online | Deploy the project to any host that runs Node and supports WebSockets: build with `npm install && npm run assets`, start with `npm start`. The server reads the `PORT` environment variable. See **Hosting publicly** next. |

## Hosting publicly

You can run the game on your own server (for example a VM in your home DMZ) and put it on the
internet through a **Cloudflare tunnel**. The tunnel only makes outgoing connections, so you don't
open any ports, and Cloudflare provides the `https://` certificate (so voice chat works with no
browser warning).

**What the server needs.** These figures were measured. The server only passes messages between
players; the host's browser runs the AI. So the machine can be small. Your **upload speed** is what
counts.

| | |
|---|---|
| CPU / RAM | 1 vCPU. The Node process uses about 60 MB of memory. No GPU. |
| Disk | About 300 MB (almost all of it `assets/`). |
| Software | Node 18 or newer, and `npm install` (one package, `ws`). |
| First visit, per player | About 95–110 MB, depending on the map. three.js (3 MB) comes from a public CDN, not from you. Repeat visits only re-check files. |
| During a mission | About 20 KB/s to each friend, 2 KB/s from each. A full room in a heavy firefight needs about 0.7 Mbit/s of upload. |
| At the limit | The server allows **5 games at once** (20 players; `MAX_ROOMS`). That needs about **3.5 Mbit/s of upload** in heavy fighting, and well under a quarter of one CPU core. Load-tested at 100 games: 33% of one core, 81 MB of memory, 68 Mbit/s up. Upload is what limits you, so measure yours before raising `MAX_ROOMS`. |

**Set it up.**

1. Get the project onto the server with `git clone https://github.com/Josh221/fps_game.git`, then
   run `npm install` and `npm run assets` in it. (If you copy a folder you already have instead,
   leave out `node_modules/` and `.certs/`.)
2. Start it so that only the tunnel can reach it, and without its own HTTPS:
   `HOST=127.0.0.1 HTTPS_PORT=0 PORT=8000 npm start`. To keep it running after you log out and
   after reboots, use pm2 (`pm2 start server/server.mjs --name dustline`, with the same variables
   set) or a systemd service. On CloudPanel, a *Node.js site* with app port 8000 does the same job.
3. Create the tunnel. In the Cloudflare dashboard, go to Zero Trust → Networks → Tunnels and create
   one. Run the install command it gives you on the server, then add a **public hostname** such as
   `game.example.com` → `HTTP` → `localhost:8000`. Point the tunnel straight at the Node port. If you
   route it through CloudPanel's nginx instead, that site's Vhost must pass WebSockets through
   (`proxy_http_version 1.1`, `proxy_set_header Upgrade $http_upgrade` and
   `proxy_set_header Connection "upgrade"`), because co-op uses `/ws`.
4. **Let Cloudflare cache the assets**, so each player's 100 MB comes from Cloudflare and not your
   home connection. Go to Caching → Cache Rules and create a rule: *URI Path starts with `/assets/`*
   → **Eligible for cache**, with Edge TTL set to *use the cache-control header*. This is needed
   because Cloudflare doesn't cache `.glb`, `.gltf`, `.bin`, `.hdr` or `.fbx` files unless told to.
   The server already marks assets as cacheable for a week when they're requested through the tunnel.
   After you change or re-download assets, use **Purge Cache**.
5. If your DMZ firewall limits outgoing traffic, allow the server to reach Cloudflare on ports
   **443** and **7844** (TCP and UDP). Nothing needs to be allowed inbound.
6. Open the game at your `https://game.example.com` address yourself (not the LAN address), so the
   invite link uses it too.

**Friends only?** By default anyone with the address can play, and lobbies show up under **Open
games** unless the host unticks *Show in "Open games"*. With only 5 games allowed, strangers could
take every slot, leaving you unable to host your own. To limit the site to people you choose, add
**Cloudflare Access** in front of it: Zero Trust → Access → Applications → *Self-hosted* →
`game.example.com`, with a policy that lists your friends' email addresses. They log in once with a
code sent by email. It's free for up to 50 users.

**What protects the server** (`server/server.mjs`, section 5, and LEARNING.md chapter 22):

- **Only the game's files are served:** `index.html`, `style.css`, `src/` and `assets/`. The server's
  code, `node_modules/`, `tools/`, the notes and the HTTPS key in `.certs/` stay private. Tricks
  like `/src/..%2Fserver.mjs` are caught.
- **Limits per visitor**, by their real address (Cloudflare passes it through in a header):

  | Limit | Value |
  |---|---|
  | Open connections per address | 12 (one home's players, plus reloads) |
  | Games (lobbies) open at once, whole server | 5 (`MAX_ROOMS`). A 6th host is told the games are taken. |
  | Open connections, whole server | `MAX_ROOMS` × 4 + 10 spare for reloads and reconnects = 30 |
  | Time to join a game after connecting | 15 seconds (the game takes under one), so idle connections can't hold places |
  | New lobbies per address | 10 every 10 minutes |
  | Wrong room codes per address | 20 every 10 minutes (stops scripts guessing codes) |
  | Messages per connection | 600 a second and 256 KB a second, with short bursts allowed |

  A full squad's host, fighting 20 enemies with everyone firing, peaked at about half of those last
  two limits. Messages over a limit are dropped. A connection sending more than 1,000 dropped
  messages in 2 seconds is cut off, and the server's log says so.
- **Your home network stays private.** Players who come in through the tunnel aren't told your LAN
  addresses.
- **Nothing a player sends is shown as HTML.** Names, chat, kits and mission text from other players
  are displayed as plain text, and game state is checked to be numbers. Otherwise a stranger
  hosting a game could run their own code in your browser.
- **A malformed message can't crash the server** for every other game.

**Settings (environment variables):**

| Variable | What it does |
|---|---|
| `PORT` | The game's port (default 8000). |
| `HOST` | `127.0.0.1` = only this machine (and a tunnel on it) can connect. Unset = every network. |
| `HTTPS_PORT` | The self-signed HTTPS port (default PORT + 443). `0` turns it off; a tunnel has its own HTTPS. |
| `MAX_ROOMS` | How many games can run at once (default 5). Allow about 0.7 Mbit/s of upload per game. |
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | Voice relay through Cloudflare's TURN service (below). |
| `TURN_URLS`, `TURN_SECRET` | Voice relay through your own TURN server (below). |
| `VOICE_RELAY_ONLY` | `1` = all voice goes through the relay, so players never see each other's home IP address. |

**Voice relay (TURN).** Voice normally goes directly between players' browsers, so they can see each
other's IP addresses, and some strict networks block it. A **TURN server** relays the audio
instead. The server gives each player a relay password that expires after 6 hours; your secret key
never leaves the server.

- **Cloudflare's TURN service** (the easy option): in the Cloudflare dashboard, open *Realtime* →
  *TURN Server* and create a TURN key. Start the game with `CF_TURN_KEY_ID=<key id>` and
  `CF_TURN_API_TOKEN=<its API token>`. Cloudflare charges $0.05 per GB, and the first 1,000 GB each
  month are free, far more than squad voice uses.
- **Your own coturn server:** turn on `use-auth-secret` and `static-auth-secret=<secret>` in
  coturn's config, then start the game with `TURN_URLS=turn:turn.example.com:3478` and
  `TURN_SECRET=<secret>`. A TURN server needs its own open UDP ports; it can't run through the
  tunnel.
- Add `VOICE_RELAY_ONLY=1` to send all voice through the relay. The startup message tells you which
  relay is active.

## Maps

| Map | Setting | How it plays |
|---|---|---|
| **Dustline** | Walled compound in dry hills, clear midday | Long sight lines across open ground, then close-quarters fighting in the compound. Guard towers and a two-storey HQ. |
| **Pinewood** | Hilltop firebase in a misty pine forest | You fight uphill through trees. Trunks, fallen logs and boulders give cover; a log palisade, bunkers and towers guard the top. |
| **Old Town** | Small town at golden hour | Street fighting. Two-storey houses with stairs, rooftop snipers, alleys, ruins, a market plaza and a street checkpoint. |

The town in Old Town is generated from rules: rows of houses with random widths, floors, materials
and windows.

Every map is **set-dressed** by `src/decor.js`:
- **Houses:** furnished rooms (living rooms with kitchens and bookcases, bedrooms, shops with
  counters and stocked shelves), doors standing open, glass and glazing bars, painted shutters,
  curtains, balconies, clay-tile pitched roofs, shop signs and awnings, posters, graffiti, house
  numbers, rain pipes and weathering streaks.
- **Old Town's streets:** kerbs, road markings, zebra crossings, street lamps, road signs, bins,
  litter and manhole covers.
- **Dustline and Pinewood:** an ops room, barracks and a workshop inside the buildings, plus razor
  wire, HESCO barriers, camo nets, floodlights, a mess area or campfire, duckboards and military
  signs.

## Graphics settings

| Setting | What it changes |
|---|---|
| **Low** | No ambient occlusion or bloom, smaller shadow maps, about a third of the grass. |
| **Medium** (default) | Ambient occlusion, bloom, 4K shadow map, MSAA anti-aliasing. |
| **High** | Everything on Medium, plus 1.5× render resolution on Retina screens, more grass, and leaf shadows from nearby trees. |

Graphics settings only change how the world *looks*. The level itself (buildings, crates, trees,
rocks) is identical on every preset, so co-op players on Low and High have the same cover.

**Frame rate** (detected from your monitor):

| Option | Behavior |
|---|---|
| **Auto** (default) | Runs at your monitor's full refresh rate. If that can't be held even at reduced resolution, it locks to half rate (for example, 50 FPS on a 100 Hz monitor), which feels smoother than a number that keeps jumping. |
| **Full** | Always tries for the full refresh rate. |
| **Half** | Always runs at half the refresh rate, evenly paced. |

**Dynamic resolution** is always on. If frames run slow, the game renders fewer pixels (down to 60–70%)
and steps back up when there's headroom, the same way consoles do. The FPS counter in the bottom
right shows the current resolution when it's below 100%. Pinewood is the heaviest map because of
the forest.

## Controls

| Key | Action | Key | Action |
|---|---|---|---|
| WASD | Move | Mouse | Look |
| Shift | Sprint (hold breath while aiming). On a ladder: climb faster | Space | Jump. At waist-high cover: vault over it (keeps your speed). At a window: dive through. At a ledge up to 2.2 m: climb up. When crouched or prone: get up one level. On a ladder: let go. |
| Walk into a ladder | Grab it; W / S climb up / down (from a roof: walk toward the ladder to climb down) | | |
| C | Crouch (toggle) | Z | Go prone / stand up |
| Q / E | Lean left / right | G | Lethal grenade (you carry 2): hold, release to throw (claymore: release to plant). A frag cooks while you hold it |
| X | Tactical grenade (you carry 1): smoke, flashbang or decoy | | |
| T / middle mouse | Spot the enemy under your crosshair | M | Full tactical map |
| Left mouse | Fire | Right mouse | Aim down sights |
| R | Reload | V | Fire mode (auto / semi) |
| 1 / 2 | Primary / sidearm | H | Apply bandage |
| Mouse wheel | Swap weapon. While aiming with the sniper scope: zoom in (up) / out (down) | | |
| F | Resupply at an ammo crate. At a body: take the ammo that fits your guns. Hold F at a gun on the ground: swap yours for it | Esc | Pause |

### The fallen

Every soldier falls his own way. The killing shot knocks him over in the direction it was going,
he twists as he goes down, and he ends up on his back, his front or half on his side, arms and
legs sprawled differently each time. His gun leaves his hands straight away, part way down or as
he hits the ground, then tumbles and skids to a stop, so it can lie a couple of metres off or
right by his hand. In co-op the whole squad sees the same fall.

What he carried is yours to take. Enemies carry different guns (mostly carbines, some SMGs,
scoped DMRs and LMGs), each with spare magazines in his pouches:

- **Look at the body, press F** to take the ammo that fits your guns. Ammo goes by calibre: a dead
  SMG gunner's 9 mm feeds your sidearm, a marksman's 7.62 feeds a DMR or a bolt-action, and 5.56
  feeds a carbine or an LMG. You can carry as much as your gun's normal reserve.
- **Look at his gun, hold F** to swap it for the one in that slot. Yours drops at your feet with
  the rounds you had for it, so you (or a squadmate) can swap back. You get your own guns back
  when you respawn.

In co-op the host decides who gets what, so two players grabbing the same rifle can't both have it.

## Loadouts and the gunsmith

Press **LOADOUT** on the main menu, in the co-op lobby, on the pause screen or after you die.

- **Classes.** Each one is a ready-made kit you can then change:

  | Class | Primary | Grenades (2 lethal + 1 tactical) | Armour |
  |---|---|---|---|
  | Rifleman | 5.56 carbine, red dot, vertical grip | 2 frag + smoke | Light |
  | Marksman | 7.62 DMR, 3x prism, long barrel | 2 impact + smoke | Light |
  | Support | 5.56 LMG (100-round belt), holo, bipod | 2 frag + smoke | Heavy |
  | Close Quarters | 9mm SMG, holo, suppressor, short barrel | 2 frag + flashbang | Light |
  | Sniper | 7.62 bolt-action, 3-12x scope, suppressor, bipod | 2 sticky + decoy | None |

- **Mod your guns.** Every gun has slots: optic, muzzle, barrel, underbarrel, magazine, stock
  and ammo. Each gun only takes the parts that make sense for it.
  - Hover over a part to see what it changes. The stat bars turn green or red, the 3D preview
    shows the part on the gun, and the kit panel shows how much heavier you'll be.
  - Drag the gun to rotate it.
- **What the parts do:**
  - **Optics:** iron sights, red dot and holo are 1x. The 3x prism and the sniper scope zoom in
    and show a full scope view with its own reticle. Your sensitivity drops to match the zoom.
  - **Variable sniper scope (3-12x):** while aiming, scroll up to zoom in and down to zoom out
    (3, 4, 5, 6, 8, 10, 12x). It starts at 6x and stays where you leave it. More zoom shows more
    detail but a narrower view, and the sway and scope shadow look bigger. The prism is a fixed
    3x, like the real thing.
  - **Suppressor:** enemies hear you from about a third of the distance, and the muzzle flash
    almost disappears.
  - **Bipod:** deploys automatically when you're prone, or crouched behind waist-high cover.
    Recoil and sway nearly vanish.
  - **Ammo:** armour-piercing goes through more cover. Hollow-point does more damage but barely
    penetrates.
- **Weight matters.** Everything you carry has a weight. A heavy kit (the LMG with heavy plates
  is about 27 kg) moves slower and runs out of stamina sooner. Armour cuts torso damage (light
  20%, heavy 40%) and grenade blasts.
- **Grenades: 2 lethal + 1 tactical.** Pick a type for each pouch in the armory under
  **GRENADES & ARMOUR**. Ammo crates refill both.
  - **Lethal (G), you carry 2:**
    - **Frag:** bounces and rolls, with a 4 s fuse. Hold G to cook it so enemies have no time to
      run.
    - **Sticky:** stops dead on the first thing it touches. Hit a soldier and it rides along on
      him. It goes off 2.5 s after the throw, with a smaller blast than a frag.
    - **Impact:** explodes the instant it hits something. It arms after a few metres, so it
      can't go off in your face. Smaller blast, and you can't cook it.
    - **Claymore:** a directional mine. Hold G, then release to plant it on the ground in front
      of you, facing where you look.
      - **Trigger:** about 1.5 s after planting it arms. After that it fires the moment an enemy
        walks into the area just in front of it.
      - **Blast:** steel balls fly out in a 60° fan, deadly to about 10 m. Behind it you're
        safe unless you're right on top of it, so don't stand in front of your own.
      - **Minimap:** your squad's claymores show as blue fans.
      - **Weight:** 3.2 kg for the pair.
  - **Tactical (X), you carry 1:**
    - **Smoke:** pops about a second and a half after it lands and builds a thick cloud that
      lasts about 30 seconds. The AI cannot see through it, so use it to cross open ground or
      to pull back from a fight you're losing.
    - **Flashbang:** no damage, but anyone who can see it go off is blinded for up to about 5 s.
      It's worst close up and when looking straight at it. Blinded enemies stop, crouch and
      can't shoot. It works on you too: your screen goes white and your ears ring, so look
      away or throw it round a corner.
    - **Decoy:** lands, then fakes bursts of rifle fire for 12 s. Enemies who hear it go to
      investigate, so use it to pull them out of position or away from you.
- **Bolt-action:** you work the bolt after every shot, so make each one count.
- **Paint your guns.** The **PAINT** slots change only how a gun looks, never how it shoots:
  - **Finish:** the stock, grip and handguard. Choose a solid colour, a camo pattern (woodland,
    desert, multi-terrain, tiger stripe, digital or arctic) or walnut wood.
  - **Metal:** the receiver, barrel and optics. Choose black anodised, gunmetal, a matte ceramic
    coating (sniper grey, FDE, OD), burnt bronze or stainless steel.
  - **Reticle:** the colour of the lit dot, holo ring, pistol dot and 3x chevron: red, green,
    amber or cyan.
  - Each gun remembers its own paint job, and painting a gun doesn't turn your class into
    "Custom".
- **Customise your soldier.** Pick **SOLDIER → APPEARANCE** in the armory to dress the animated
  soldier your squad sees:
  - **Armour:** the colour or camo of the helmet and plates.
  - **Uniform:** the colour or camo of the cloth. This is also your sleeves in first person, and
    your backpack.
  - **Markings:** the colour of the helmet and shoulder stripes.
  - **Visor:** smoked, or a silver, gold or blue mirror.
  - **Gloves:** the gloves on your hands in first person.
  - **Head:** a comms headset and/or night vision goggles.
  - **Back:** nothing, an assault pack or a radio with a whip antenna.

  Scroll to zoom in on the gear. **RANDOMISE** rolls a new look. Unlike your guns, a look change
  applies straight away, even mid-mission.
- **Co-op:** your squadmates see your soldier exactly as you dressed it, and the gun you actually carry
  with every attachment and paint job you picked. They also see when you switch to your sidearm, and the bipod legs come down when you
  lie prone.
- **Mid-mission changes.** If you change your loadout during a mission, you get the new kit at
  the next ammo crate (**F**) or when you respawn. That stops anyone using it as a free refill.
  Your loadout, paint jobs and look are saved in the browser.

## Tactical features

- **Minimap and radar (top right).** It rotates with you and shows a real overhead photo of the
  map, with your squad in blue and ammo crates in yellow. The **Enemy radar** setting decides when
  enemies appear on it. It's a mission rule, like difficulty: solo, pick it on the menu next to
  Difficulty; in co-op the host picks it in the lobby and the whole squad gets the same radar.

  | Setting | Who shows up |
  |---|---|
  | Always on | Every enemy, all the time (like a UAV overhead) |
  | When firing (default) | Enemies appear briefly when they shoot (Call of Duty style) |
  | Spotted only | Only enemies you or your squad have spotted with **T** (Battlefield style) |
  | Off | Hardcore: no enemy dots at all |

- **Spotting (T).** Marks the enemy you're looking at with a red diamond for 7 seconds, on screen
  and on everyone's minimap in co-op.
- **Tactical map (M).** A north-up map with a 50 m grid (A–F across, 1–6 down) for calling
  positions to your squad.
- **Throwing grenades (G / X).** Hold the key to pull the pin, then release to throw. The
  HUD shows what's in each pouch.
  - **Cooking:** a frag, smoke or flashbang starts its fuse as soon as you pull the pin. Hold
    a frag longer than 4 seconds and it goes off in your hand. Sticky, impact and decoy only
    start when they leave your hand.
  - **Physics:** grenades bounce off walls and roll to a stop (except sticky, which sticks).
  - **Damage:** it falls off with distance, and solid cover blocks it completely.
  - **Enemies:** they run from grenades that land near them, and throw their own at you when
    you hide behind cover too long.
  - **Warning:** a red icon marks any live grenade near you.
- **Stances.** You can stand, crouch (C) or go prone (Z).
  - **Prone:** the steadiest aim, the smallest target, and nearly invisible in tall grass. You
    crawl slowly and can't shoot while getting down or up.
- **Vaulting and climbing.** Press Space at sandbags, barriers or crates to hurdle them (you keep
  running), at a window to dive through it, or at a chest-high ledge to pull yourself up onto
  it. A prompt at the bottom of the screen tells you when you can.
- **Ladders.** Every two-storey house in Old Town has a steel ladder up an alley wall, so any
  rooftop sentry can be reached, and so do some one-storey houses. Dustline has ladders to the HQ
  roof and the stacked containers, and Pinewood to the HQ roof and a bunker. Walk into a ladder
  to grab it, then W/S to climb. You can't shoot while climbing, and neither can the enemy.
  Soldiers use ladders too: get on a roof and they'll come up after you.
- **Fall damage.** Drops over ~3 m hurt: a two-storey roof costs about half your health, and
  ~9.5 m is fatal. A hard landing leaves you limping until you bandage (H). Land crouched (C) to
  take a third less.

## Graphics features

- **Sky and sunlight:** each map is lit by a real photographed sky (an HDR image). The sun is found
  inside that photo, so its brightness, color and direction match what you see. Light bouncing off
  the ground is added too, so building ceilings aren't pitch black.
- **Materials:** surfaces use scanned textures with color, surface detail, roughness and ambient
  occlusion maps. Walls use world-space texture coordinates, so plaster and brick run on unbroken
  around windows and doors.
- **Set dressing:** furniture and clutter are mostly low-poly shapes built in code, with signs,
  posters, fabrics and paints packed into a few texture atlases. A whole furnished town costs only
  a few extra draw calls.
- **Terrain:** up to three ground textures (for example dirt, gravel and rock) are blended
  according to slope and location.
- **Vegetation:** tens of thousands of instanced grass clumps sway in the wind, and procedurally
  generated pine, oak and aspen trees use a lower-detail version in the distance.
- **Soldiers:** four realistic soldiers from Microsoft's Rocketbox library (faces, helmets, plate
  carriers, 80-bone skeletons with every finger), playing motion-captured idle, walk and run clips.
  Enemy factions wear their uniform recoloured per map. Arms are posed onto the gun with two-bone
  inverse kinematics, the hands turned to hold it and the fingers curled round it. They kneel
  behind cover, and their hitboxes follow their bones.
- **First-person arms:** the same soldier model, in your look, posed every frame so your hands stay
  on the gun through sway, recoil and reloads. Guns are built to real dimensions (an M4-type
  carbine is ~0.86 m) and carried with the stock in the shoulder, so a gun is exactly as big as it
  would look in your own hands.
- **Post-processing:** ambient occlusion (darkening in corners), bloom, film tone mapping, color
  grading, vignette and film grain.
- **Shadows:** a 4096-pixel shadow map that follows the player and stays steady as you move.
- **Atmosphere:**
  - a sun lens flare (only when nothing blocks the sun)
  - dust motes drifting in the air
  - smoke from the barrel after each shot
  - footsteps that sound like the surface (gravel, grass, sand, rock, concrete, asphalt, wood,
    metal), heel then toe, left and right feet, never the same take twice in a row
  - your kit rattling as you move (more when you run or carry more), jump and landing thumps
  - holding your breath to aim, and gasping for air if you hold it too long (sprinting just slows to a jog when you're tired, no panting)
  - a small-room echo when you're indoors
  - enemies' and squadmates' footsteps in 3D, on their own surface
  - distant battle sounds
  - muffled, ringing hearing after a nearby explosion
- **Getting shot:** a red flash, blood-red screen edges, blood spattered on the side the shot came
  from, a red arc around the crosshair that keeps pointing at the shooter as you turn, a body-hit
  thud and grunt (a plate "tok" if your armour took it), and a moment of muffled hearing. While
  badly hurt the edges stay red and pulse with your heartbeat.

## Project layout

```
index.html / style.css     page, HUD, menus
tools/fetch-assets.mjs     downloads the assets (the "asset pipeline")
assets/                    downloaded textures, models, HDR skies + CREDITS.md
src/
  main.js        loads a map, wires systems together, game loop, waves
  config.js      ALL gameplay numbers (speeds, damage, recoil, AI)
  render.js      renderer, HDR sky + sun extraction, shadows, post-processing
  assets.js      cached loaders (textures, PBR materials, glTF, HDR)
  materials.js   per-map material palettes, gun finishes
  terrain.js     heightfield terrain, noise, texture splatting
  vegetation.js  instanced grass, EZ-Tree forests, procedural boulders
  props.js       instanced glTF props, sandbag walls
  builder.js     prefabs: walls, buildings (1-2 floors, stairs), towers, palisades...
  decor.js       set dressing: furniture, doors, shutters, signs, grime, street + camp clutter
  maps/          dustline.js, pinewood.js, oldtown.js (+ index.js registry)
  world.js       collision boxes + terrain, movement, raycasts
  nav.js         A* pathfinding grid for the AI, plus roof "decks" joined by ladders (off-mesh links)
  ladder.js      fixed steel ladders: the prefab and the data players and soldiers climb with
  character.js   soldiers: loads the Rocketbox models, animation blending, two-bone IK arms + finger grips, hitboxes, deaths
  enemy.js       enemy AI state machine + squad manager, and which gun each soldier carries
  player.js      movement, stance, lean, stamina, health, camera
  weapon.js      ammo, fire modes, reloads, spread, recoil
  viewmodel.js   first-person gun + hands: sway/bob/recoil, bolt cycling, bipod legs
  loadout.js     guns, attachments (as stat modifiers), classes, kit weight
  gunsmith.js    builds each gun's 3D model from its parts (optics, muzzles, mags...)
  armory.js      the loadout screen: classes, gun list, attachment + paint slots, stats, soldier tab, 3D preview
  paint.js       the paint shop: colours and camo patterns shared by guns, uniforms and gear
  avatar.js      your soldier's look: repaints the soldier texture, bolts on gear, sleeves + gloves
  scope.js       the scope view for magnified optics (mask, reticles, scope shadow)
  ballistics.js  bullet simulation, penetration, hit detection
  effects.js     particles, bullet holes, tracers, muzzle flash, brass
  audio.js       synthesised 3D audio (gunfire, baked footstep takes, breathing, indoor echo)
  gundrop.js     a dropped gun: tumbles, bounces, skids and lies on its side (physics with a fixed time step)
  loot.js        taking ammo and guns off the fallen (calibres, gun swaps, the host deciding in co-op)
  coop.js        co-op: lobby protocol, who decides what, snapshots, enemy "puppets", hit reports
  lobby.js       the lobby screen and the "open games" list
  voice.js       squad voice chat (WebRTC, push-to-talk)
  net.js         WebSocket client, clock sync, interpolation buffers
  teammate.js    a squadmate drawn from network updates
  grenades.js    every grenade (frag, sticky, impact, smoke, flashbang, decoy) + claymores
  minimap.js     minimap + radar modes, tactical map, spotting, grenade warnings
  hud.js, input.js, textures.js
  campaign/      the story campaign:
    story.js       the setting, the cast and every mission's script (pure data: edit this to change a mission)
    director.js    runs a mission: objectives, enemy groups, triggers, checkpoints, bonus goals, co-op sync
    escort.js      a person you have to keep alive (Dr. Marr): follows the squad, can be shot
    props.js       mission props (laptop, weapons cache, charges, jammer) and demolition blasts
    radio.js       radio calls: subtitles + text-to-speech voices, broken up while jammed
    hud.js         objective markers, NEW OBJECTIVE banners, the title card
    screens.js     mission list, briefing (with a tactical map), debrief, saved progress
server/
  server.mjs     web server + lobby server (rooms, ready-up, chat, rejoin) + co-op relay
```

## Tweaking

- **Gameplay** numbers are in [src/config.js](src/config.js). That includes the difficulty presets
  (`DIFFICULTY`), mission lengths and co-op wave scaling (`GAME`), and co-op network settings
  (`NET`: update rate, respawn time, countdown, squad uniform colour). What enemies carry and how
  they fire it is `ENEMY_ISSUE`: set a gun's `share` to 0 to stop enemies using it, or add your own
  entry. `LOOT` sets how close you need to be to a body and how long to hold F to swap guns.
- **Each map's look** is set in its map file: which sky image, exposure, fog, color grade,
  textures and soldier uniform color. Try swapping Dustline's `hdri` for another sky listed in
  [tools/fetch-assets.mjs](tools/fetch-assets.mjs).
- **New maps:** copy a map file, change it, and add it to
  [src/maps/index.js](src/maps/index.js).
- **Missions:** everything about a mission (enemies, objectives, dialogue, briefing) is data in
  [src/campaign/story.js](src/campaign/story.js). The comment at the top lists every objective type,
  action and trigger. Add a mission to `MISSIONS` and it appears on the menu.
- **More assets:** add a Poly Haven ID to the lists in
  [tools/fetch-assets.mjs](tools/fetch-assets.mjs) and run `npm run assets`.

`window.game` in the browser console gives live access to everything. For example,
`game.player.health = 1000`.

## Credits

Textures, models and skies come from [Poly Haven](https://polyhaven.com) (CC0), and the trees from
EZ-Tree (MIT, loaded from a CDN). The Poly Haven files aren't stored in this repository:
`npm run assets` downloads them and writes the full list, asset by asset, to `assets/CREDITS.md`.

The soldiers and their animations are from the Microsoft Rocketbox avatar library
(github.com/microsoft/Microsoft-Rocketbox), released under the MIT licence; the licence text is in
assets/characters/rocketbox/LICENSE.md. `npm run characters` downloads and converts them.
