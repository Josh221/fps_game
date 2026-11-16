// =============================================================================
// campaign/story.js — the story, the people in it, and every mission's SCRIPT.
//
// This file is pure DATA: no game code. The mission director (director.js)
// reads it and makes it happen. That split is how real games do it. Designers
// write missions in a scripting language or a visual editor (Unreal's
// Blueprints, Far Cry's Dunia scripts, Arma's mission editor), and
// programmers write the engine that runs them. To change a mission, or write
// a new one, you only touch this file.
//
// COORDINATES: metres, x = east, z = SOUTH (so north is -z), y = up. "Facing"
// (yaw) is in radians: 0 = north, Math.PI = south, -Math.PI/2 = east,
// Math.PI/2 = west. Heights are worked out from the ground, except for
// sentries placed on towers and roofs, which give their own height.
//
// A MISSION has:
//   start       where the squad deploys:          [x, z, yaw]
//   groups      named sets of enemy soldiers, spawned by actions
//   begin       actions run when the mission starts
//   objectives  done one after another (types below)
//   bonus       optional goals: each one earns a star (finishing earns one)
//   radio       the dialogue, by key: [[speaker, line], ...]
//   alarm       actions run once, the first time an enemy spots the squad
//
// OBJECTIVE TYPES (see director.js for exactly how each one works):
//   goto     reach a place                    at: [x, z], radius, who: 'any'|'all'
//   clear    kill every soldier in groups     groups: ['name', ...]
//   observe  aim down sights at targets       targets: [{ at: [x, z, height], label, range }]
//   use      hold F at sites                  sites: [{ at: [x, z] | on: 'hvt', label, verb, time }]
//   hold     stay in a zone for a time        at, radius, time, waves: { from, every, size, max }
//   timer    wait (a fuse, a helicopter)      time
//   hvt      kill (or capture) one man        target: 'group name' (its hvt soldier)
//   escort   get the VIP to a place           to: [x, z], radius
// Every objective can also have:
//   start: [actions]    run when it begins     done: [actions]  run when it's complete
//   retry: [actions]    run when the squad restarts here from a checkpoint
//   checkpoint: [x, z, yaw]   where the squad restarts (and respawns in co-op)
//
// ACTIONS: { spawn: 'group' } { radio: 'key' } { show: 'prop' } { hide: 'prop' }
//   { boom: 'prop' } (a demolition charge goes off) { vip: 'follow' }
//   { jam: false } (radio jamming off) { alarm: true }. Add after: seconds to delay one.
//
// TRIGGERS (`triggers`) run actions once, when: { near: [x, z, r] } someone in
// the squad gets that close; { vipNear: [x, z, r] } the escort does;
// { vipHurt: true } the escort is first hit; { surrender: 'key' } an HVT gives
// up. Add hvtAlive: 'key' to only fire while that HVT is still fighting.
// =============================================================================

// ---------------------------------------------------------------- helpers
// Enemy soldiers. Roles come from enemy.js: a guard stands his post and looks
// around, a patrol walks between the map's patrol points, a sentry never
// leaves his tower or roof. `to: [x, z]` sends a guard walking there.
const guard = (x, z, yaw, more) => ({ role: 'guard', x, z, yaw, ...more });
const patrol = (x, z, more) => ({ role: 'patrol', x, z, ...more });
const sentry = (x, y, z, yaw) => ({ role: 'sentry', x, y, z, yaw });
const N = 0, S = Math.PI, E = -Math.PI / 2, W = Math.PI / 2; // facing north, south, east, west

// Looks (avatar.js) for the people who matter: you can tell them apart at a glance.
const LOOKS = {
  marr: { armour: 'urban', uniform: 'urban', markings: 'blue', visor: 'none', gloves: 'grey', head: 'none', back: 'none', soldier: 'f1' },
  courier: { armour: 'sand', uniform: 'coyote', markings: 'white', visor: 'smoke', gloves: 'tan', head: 'headset', back: 'radio', soldier: 'm3' },
  kade: { armour: 'black', uniform: 'black', markings: 'red', visor: 'gold', gloves: 'black', head: 'headset', back: 'none', soldier: 'm1' },
};

// Pinewood's winding dirt track: x at a given z (copied from maps/pinewood.js)
const trackX = (z) => Math.sin(z * 0.045) * 14 + Math.sin(z * 0.11) * 4;
const PY = 14; // Pinewood's hilltop plateau height

// ---------------------------------------------------------------- the people
// Each speaker has a voice for the radio (radio.js picks a matching voice
// that the browser has, then changes its pitch and speed).
export const CAST = {
  SHEPHERD: { name: 'Maj. Nadia Rourke', role: 'CSF operations, Camp Halden', voice: { gender: 'f', pitch: 0.95, rate: 1.05 } },
  RAVEN: { name: 'Lt. Tomas Vey', role: 'Drone operator', voice: { gender: 'm', pitch: 1.1, rate: 1.12 } },
  MARR: { name: 'Dr. Elise Marr', role: 'Ceasefire inspector', voice: { gender: 'f', pitch: 1.15, rate: 1.0 } },
  WARDEN: { name: 'Silas Kade', role: 'Corvane field commander', voice: { gender: 'm', pitch: 0.7, rate: 0.92 } },
  SABRE: { name: 'Sabre', role: 'Your squad', voice: { gender: 'm', pitch: 1.0, rate: 1.1 } },
};

export const CAMPAIGN = {
  title: 'OPERATION DUSTLINE',
  intro: 'The Corran Valley has been under a ceasefire for eight months: dry hills in the south, pine forest in the north, '
    + 'and the market town of Mereth in between. The Corran Stabilisation Force (CSF) keeps the peace with too few soldiers. '
    + 'Corvane Security, the private army hired to guard the valley\'s mines, has started taking what it was paid to protect. '
    + 'You are SABRE, the CSF\'s quick-reaction squad.',
};

// =============================================================================
export const MISSIONS = [
  // ===========================================================================
  // 1. GHOST WALK — recon in the fog. Teaches observing, stealth and the HUD.
  {
    id: 'ghost-walk',
    title: 'GHOST WALK',
    map: 'pinewood',
    time: 'DAY 1 · 05:40',
    place: 'Pinewood Ridge, northern Corran Valley',
    blurb: 'Recon. Climb the ridge in the fog, watch the firebase, ambush a courier.',
    // Thick fog: everything is murkier, and the enemy can't see as far either
    atmosphere: { exposure: 0.88, fog: 1.45, sun: 0.85, sight: 45, grade: { saturation: 0.78, tint: 0xe8f0ff } },
    briefing: {
      situation: 'Two days ago Corvane walked into FOB Pinewood, the hilltop firebase we handed back to the valley when the ceasefire began. '
        + 'Since then a radio mast up there has been talking to someone we can\'t identify. And Dr. Elise Marr, the ceasefire inspector '
        + 'who reported Corvane moving weapons, has stopped answering hers.',
      mission: 'Climb through the forest under the fog and get eyes on the firebase: the radio mast, the west gun tower and the east outpost. '
        + 'A courier leaves the firebase at first light. Take him and his satchel, then get down to the pickup in the valley.',
      notes: [
        'Aim down your sights (right mouse) at a target and hold steady to observe it.',
        'The fog hides you: they can\'t see far today. Crouch (C) or go prone (Z) in the long grass and they\'ll barely see you at all.',
        'If they raise the alarm, a quick-reaction force comes down the hill.',
      ],
    },
    start: [-28, 100, -0.27],
    groups: {
      base: [
        sentry(-24, 18.5, 8, S), sentry(25, 18.5, -30, S), sentry(0, PY + 3, -27, S),
        guard(-2, 11, S), guard(14, -1, S), guard(-16, -24, E), patrol(13.5, -18), guard(-9, -9, S),
      ],
      slope: [
        guard(trackX(40) - 3.5, 38.6, S), guard(-27, 33.6, S), guard(32, 28.6, S), guard(trackX(55) + 5.5, 53.6, S),
        patrol(-20, 40), patrol(22, 45), guard(34.6, 28.6, S),
      ],
      // The courier and his escort walk out of the south gate and down the track
      courier: [
        guard(13, 7, S, { to: [trackX(70), 70], hvt: { key: 'courier', name: 'COURIER', look: LOOKS.courier, hp: 1 } }),
        guard(11.4, 5.6, S, { to: [trackX(68) - 1.6, 67.5] }),
        guard(14.6, 5.6, S, { to: [trackX(68) + 1.6, 67.8] }),
      ],
      qrf: [guard(12, 5, S), guard(14.5, 4.5, S), guard(11.6, 7.8, S), guard(14.4, 7.8, S), guard(13, 1, S)],
    },
    begin: [{ spawn: 'base' }, { spawn: 'slope' }, { radio: 'start' }],
    alarm: [{ spawn: 'qrf', assault: true }, { radio: 'alarm' }],
    objectives: [
      {
        id: 'observe', type: 'observe', text: 'Observe the firebase',
        targets: [
          { at: [33, 30.2, 1.2], label: 'EAST OUTPOST', range: 85, radio: 'obs1' },
          { at: [14, -15.6, 11], label: 'RADIO MAST', range: 95, radio: 'obs2' },
          { at: [-24, 8, 5.8], label: 'WEST GUN TOWER', range: 80, radio: 'obs3' },
        ],
        time: 1.6,
        checkpoint: [-28, 100, -0.27],
        done: [{ radio: 'observed' }],
      },
      {
        id: 'courier', type: 'hvt', target: 'courier', text: 'Ambush the courier on the track',
        start: [{ spawn: 'courier', after: 4 }],
        retry: [{ spawn: 'slope' }],
        checkpoint: [24, 70, 0.3],
        done: [{ radio: 'courierDown' }],
      },
      {
        id: 'satchel', type: 'use', text: 'Take the courier\'s satchel',
        sites: [{ on: 'courier', label: 'SATCHEL', verb: 'TAKE THE SATCHEL', time: 2 }],
        checkpoint: [24, 70, 0.3],
        done: [{ radio: 'satchel' }, { alarm: true }],
      },
      {
        id: 'exfil', type: 'goto', text: 'Get to the pickup in the valley', at: [-44, 92], radius: 8, who: 'all', label: 'PICKUP',
        retry: [{ spawn: 'qrf', assault: true }],
        checkpoint: [10, 74, 2.8],
        done: [{ radio: 'out' }],
      },
    ],
    bonus: [
      { id: 'ghost', type: 'undetected', until: 'observe', text: 'Ghost: stay hidden until the firebase is observed' },
      { id: 'clean', type: 'nodeaths', text: 'Clean: nobody in the squad is killed' },
    ],
    radio: {
      start: [['SHEPHERD', 'Sabre, Shepherd. The fog\'s holding on the ridge. Get eyes on that firebase, and keep your heads down.'],
        ['RAVEN', 'Raven\'s overhead, but the cloud\'s too thick for my camera. Today you\'re my eyes.']],
      obs1: [['RAVEN', 'East outpost logged. Two men behind sandbags.']],
      obs2: [['RAVEN', 'That mast is a long-range set. Logged.']],
      obs3: [['RAVEN', 'Gun tower logged. That\'s a heavy machine gun up there.']],
      observed: [['SHEPHERD', 'That set isn\'t talking to their own people. It\'s talking to Mereth.'],
        ['RAVEN', 'Movement at the south gate: a runner and two escorts, heading down the track. That\'s your courier.']],
      courierDown: [['SHEPHERD', 'Courier\'s down. Get his satchel before anyone comes looking.']],
      satchel: [['SHEPHERD', 'Got it. Now get off that hill. Pickup is in the valley, west of the track.']],
      alarm: [['RAVEN', 'They\'ve seen you! Troops coming out of the south gate.'], ['SHEPHERD', 'So much for quiet. Fight your way out.']],
      out: [['SHEPHERD', 'Sabre is off the hill. Good work. Let\'s see what that courier was carrying.']],
    },
    debrief: () => 'The satchel held a shipping manifest: rifles, mortar rounds and explosives, signed WARDEN. That is the call sign of '
      + 'Silas Kade, Corvane\'s field commander. Folded inside was a note: "The inspector stays in Mereth until the shipment clears Dustline." '
      + 'Dr. Marr is alive.',
  },

  // ===========================================================================
  // 2. MARKET DAY — a rescue in the town. Teaches escorting and holding.
  {
    id: 'market-day',
    title: 'MARKET DAY',
    map: 'oldtown',
    time: 'DAY 2 · 16:50',
    place: 'Mereth old town',
    blurb: 'Rescue. Break into the town, free the ceasefire inspector and get her out alive.',
    atmosphere: { sight: 60 },
    briefing: {
      situation: 'Dr. Elise Marr is being held in Mereth\'s old town. Corvane has a checkpoint on the south road and men in the market square. '
        + 'The townspeople have gone indoors. Anyone still out on the streets is Corvane.',
      mission: 'Push through the checkpoint, find the house where Marr is held and cut her free. Then take her back down the main street to '
        + 'the south road and hold there until our trucks arrive. Keep her alive: she is the only witness we have.',
      notes: [
        'Marr follows whoever in the squad is closest to her. She keeps low when you stop.',
        'If she\'s killed, the mission fails and you go back to the last checkpoint.',
        'Corvane will send everything they have once they know she\'s gone.',
      ],
    },
    start: [-18, 110, -0.36],
    vip: { key: 'marr', name: 'DR. MARR', at: [48.6, 12, W], look: LOOKS.marr },
    groups: {
      checkpoint: [guard(-2.5, 68.6, S), guard(2.6, 71.6, S), sentry(-11.5, 6.25, 76, S), guard(-1, 64.8, S), patrol(0, 58)],
      street: [patrol(0, 40), sentry(-11, 6.25, 45, S), guard(5.4, 29.2, S)], // (beside a parked car)
      square: [guard(-3.5, 15, S), guard(4.5, 15.4, S), guard(15.3, 4.5, E), guard(-15.5, -3.5, W), patrol(12, -2), patrol(-8, 6)],
      house: [guard(45, 4.6, N), guard(48.6, 4.6, N), guard(42.5, 12.5, N), guard(50, 15.3, W)],
      counter: [patrol(-3, -45), patrol(3, -48), patrol(0, -52), patrol(42, -3), patrol(-42, 3), patrol(60, 3)],
    },
    begin: [{ spawn: 'checkpoint' }, { spawn: 'street' }, { spawn: 'square' }, { spawn: 'house' }, { radio: 'start' }],
    alarm: [],
    // One-off events
    triggers: [
      { when: { vipNear: [0, 0, 14] }, do: [{ spawn: 'counter', assault: true }, { radio: 'counter' }] },
      { when: { vipHurt: true }, do: [{ radio: 'hurt' }] },
    ],
    objectives: [
      {
        id: 'checkpoint', type: 'clear', groups: ['checkpoint'], label: 'CHECKPOINT', text: 'Clear the south checkpoint',
        checkpoint: [-18, 110, -0.36],
        done: [{ radio: 'cleared' }],
      },
      {
        id: 'house', type: 'goto', at: [46.8, 3], radius: 5, label: 'SAFEHOUSE', text: 'Reach the safehouse east of the market square',
        retry: [{ spawn: 'street' }, { spawn: 'square' }, { spawn: 'house' }],
        checkpoint: [0, 76, 0],
        done: [{ radio: 'house' }],
      },
      {
        id: 'free', type: 'use', text: 'Cut Dr. Marr free',
        sites: [{ on: 'vip', label: 'DR. MARR', verb: 'CUT HER FREE', time: 3 }],
        retry: [{ spawn: 'house' }],
        checkpoint: [40, 2, W],
        done: [{ vip: 'follow' }, { radio: 'freed' }],
      },
      {
        id: 'escort', type: 'escort', to: [0, 92], radius: 9, label: 'TRUCKS', text: 'Get Marr to the south road',
        checkpoint: [40, 2, W],
        retry: [{ spawn: 'square' }],
        done: [{ radio: 'road' }],
      },
      {
        id: 'hold', type: 'hold', at: [0, 94], radius: 14, time: 55, label: 'HOLD', text: 'Hold the road until the trucks arrive',
        waves: { from: [[-62, 62], [62, 58], [-58, 100], [60, 102], [-30, 50], [30, 48]], every: 13, size: 3, max: 12, first: 4 },
        checkpoint: [0, 96, 0],
        done: [{ radio: 'trucks' }],
      },
    ],
    bonus: [
      { id: 'unharmed', type: 'vip', min: 50, text: 'Unharmed: Marr keeps more than half her health' },
      { id: 'quick', type: 'time', minutes: 12, text: 'Quick: finish in under 12 minutes' },
    ],
    radio: {
      start: [['SHEPHERD', 'Sabre, Shepherd. The checkpoint is the only way in from the south. Take it fast, before they can warn the square.']],
      cleared: [['RAVEN', 'Checkpoint\'s clear. Marr\'s phone last pinged a house east of the market square. Two storeys, on the cross street.']],
      house: [['SHEPHERD', 'She\'s inside. Get her up and moving.']],
      freed: [['MARR', 'You\'re CSF? Thank God. They took my notes, but I remember all of it.'],
        ['SHEPHERD', 'Stay with her, Sabre. The trucks are moving to the south road.']],
      counter: [['RAVEN', 'Trucks coming in from the north, full of Corvane. They know she\'s gone.']],
      hurt: [['MARR', 'I\'m hit! I\'m okay. Keep going!']],
      road: [['SHEPHERD', 'Trucks are a minute out. Hold that road.']],
      trucks: [['SHEPHERD', 'Trucks are on you. Get her aboard. Sabre, that was well done.']],
    },
    debrief: () => 'Dr. Marr confirmed it. Corvane is moving the stolen weapons through the old CSF supply depot at Dustline and selling them '
      + 'across the border. One last convoy leaves at dusk tomorrow. If it gets out, the ceasefire goes with it.',
  },

  // ===========================================================================
  // 3. DUSTLINE — a raid. Teaches taking a position, holding it and demolition.
  {
    id: 'dustline',
    title: 'DUSTLINE',
    map: 'dustline',
    time: 'DAY 3 · 12:15',
    place: 'Dustline supply depot, southern hills',
    blurb: 'Raid. Storm the depot, steal the shipping records and blow up the weapons.',
    atmosphere: { sight: 60 },
    briefing: {
      situation: 'Dustline is an old CSF supply depot in the dry hills, with high walls, two gun towers, a headquarters and a motor pool. '
        + 'Corvane has turned it into a warehouse for the stolen weapons. The convoy leaves at dusk; at noon, half of them are asleep in the heat.',
      mission: 'Come up the south road and get inside the walls. Take the headquarters and copy the shipping records off their laptop: that is our proof. '
        + 'Then blow up the weapons in the motor pool and get out the way you came.',
      notes: [
        'The download takes time and wakes up their whole network. Expect a counterattack while it runs.',
        'The download pauses if nobody stays near the laptop.',
        'The charge has a 10-second fuse. Get clear!',
      ],
    },
    start: [0, 97, 0],
    props: [
      { id: 'laptop', kind: 'laptop', at: [-12.6, -27.4, Math.PI] },
      { id: 'cache', kind: 'cache', at: [27.6, -20, 0] },
      { id: 'charge', kind: 'charge', at: [27.6, -21.6, 0], hidden: true },
    ],
    groups: {
      gate: [sentry(42, 4.5, 42, S), sentry(-42, 4.5, -42, S), guard(0, 39.6, S), guard(2.4, 39.3, S)],
      yard: [patrol(-12, 22), patrol(16, -8), guard(20, 22, S), guard(-8, 12.5, S), sentry(7, 5.2, 6, S), patrol(-24, 8)],
      hq: [guard(-10, -31, S), guard(-3, -30, S), sentry(1, 3.4, -31, S), guard(-12, -21.5, S)],
      barracks: [guard(-38, -5, E), guard(-38, 8, E)],
      motorpool: [patrol(32, -20), guard(33, -29, W)],
      late: [patrol(-3, -60), patrol(3, -62), patrol(0, -66), patrol(60, 8)],
    },
    begin: [{ spawn: 'gate' }, { spawn: 'yard' }, { spawn: 'hq' }, { spawn: 'barracks' }, { spawn: 'motorpool' }, { radio: 'start' }],
    alarm: [{ radio: 'alarm' }],
    objectives: [
      {
        id: 'inside', type: 'goto', at: [0, 36], radius: 10, label: 'GATE', text: 'Get inside the compound',
        checkpoint: [0, 97, 0],
        done: [{ radio: 'inside' }],
      },
      {
        id: 'hq', type: 'clear', groups: ['hq'], label: 'HQ', text: 'Take the headquarters',
        retry: [{ spawn: 'hq' }, { spawn: 'barracks' }, { spawn: 'motorpool' }],
        checkpoint: [0, 34, 0],
        done: [{ radio: 'hqClear' }],
      },
      {
        id: 'laptop', type: 'use', text: 'Start the download on their laptop',
        sites: [{ prop: 'laptop', label: 'LAPTOP', verb: 'START THE DOWNLOAD', time: 1.5 }],
        checkpoint: [-6, -22, N],
        done: [{ radio: 'dlStart' }, { alarm: true }],
      },
      {
        id: 'download', type: 'hold', at: [-12.6, -28], radius: 7, time: 50, label: 'DOWNLOAD', text: 'Guard the laptop until the download finishes',
        waves: { from: [[0, -66], [-12, -64], [12, -62], [64, 10], [-64, -20]], every: 11, size: 3, max: 12, first: 3 },
        halfway: [{ radio: 'dlHalf' }],
        checkpoint: [-6, -22, N],
        done: [{ radio: 'dlDone' }],
      },
      {
        id: 'cache', type: 'use', text: 'Plant the charge on the weapons cache',
        sites: [{ prop: 'cache', label: 'WEAPONS CACHE', verb: 'PLANT THE CHARGE', time: 4, range: 2.6 }],
        retry: [{ spawn: 'motorpool' }],
        checkpoint: [8, -14, E],
        done: [{ show: 'charge' }, { radio: 'charge' }],
      },
      {
        id: 'fuse', type: 'timer', time: 10, text: 'Get clear of the blast!',
        checkpoint: [8, -14, E],
        done: [{ boom: 'cache' }, { hide: 'charge' }, { radio: 'boom', after: 1.5 }],
      },
      {
        id: 'exfil', type: 'goto', at: [0, 70], radius: 10, who: 'all', label: 'EXFIL', text: 'Get out down the south road',
        start: [{ spawn: 'late', assault: true }],
        checkpoint: [0, 30, S],
        done: [{ radio: 'out' }],
      },
    ],
    bonus: [
      { id: 'quiet', type: 'undetected', until: 'inside', text: 'Quiet entry: get inside the walls before they raise the alarm' },
      { id: 'clean', type: 'nodeaths', text: 'Clean: nobody in the squad is killed' },
    ],
    radio: {
      start: [['SHEPHERD', 'Sabre, Shepherd. Two gun towers on the corners and guards on the gate. Take the towers out first and they\'re half blind.']],
      alarm: [['RAVEN', 'That\'s it, they know you\'re here.']],
      inside: [['RAVEN', 'You\'re in. The headquarters is the two-storey block on the north side. That\'s where their laptop is.']],
      hqClear: [['SHEPHERD', 'The headquarters is yours. Find the laptop and start the download.']],
      dlStart: [['RAVEN', 'Download running. Their whole network just lit up. Counterattack coming from the north gate.']],
      dlHalf: [['RAVEN', 'Halfway there. Keep them off that laptop.']],
      dlDone: [['SHEPHERD', 'We have everything: every crate, every buyer, every payment. Now the weapons. They\'re in the motor pool shed.']],
      charge: [['SHEPHERD', 'Charge is set. Ten seconds! Get clear!']],
      boom: [['RAVEN', 'Whoa. That is a big fire. Their shipment is finished.']],
      out: [['SHEPHERD', 'Sabre is out. Outstanding.']],
    },
    debrief: () => 'The records went straight to the ceasefire commission, and within the hour Corvane\'s contract was cancelled. '
      + 'Within two hours, Silas Kade\'s men had stormed FOB Pinewood again and turned its radio mast into a jammer. Every CSF radio in the north '
      + 'of the valley has gone deaf. Kade is not leaving quietly.',
  },

  // ===========================================================================
  // 4. HIGH GROUND — an assault uphill, then a last stand on the hill.
  {
    id: 'high-ground',
    title: 'HIGH GROUND',
    map: 'pinewood',
    time: 'DAY 4 · 07:10',
    place: 'FOB Pinewood',
    blurb: 'Assault. Take the hill, destroy the jammer and hold the firebase against the counterattack.',
    atmosphere: { exposure: 0.95, fog: 1.1, sight: 60 },
    jammed: true, // radio messages are broken up until the jammer is destroyed
    briefing: {
      situation: 'Kade has dug in on the hill. A jammer on the radio mast is cutting the CSF\'s radios across the north of the valley, '
        + 'and outposts on the slope cover every way up.',
      mission: 'Take the outposts on the slope, break into the firebase and destroy the jammer at the foot of the mast. '
        + 'Then clear the base and hold the hill. Kade will throw everything he has left at you to get it back.',
      notes: [
        'Until the jammer is gone, your radio will be broken up and Raven can\'t help you.',
        'Ammo crates: one in the valley where you start, one in the middle of the base.',
        'When the counterattack comes, stay inside the firebase or the relief column can\'t land.',
      ],
    },
    start: [55, 100, 0.45],
    props: [
      { id: 'jammer', kind: 'jammer', at: [15.4, -17.6, -0.8] },
      { id: 'charge', kind: 'charge', at: [15.4, -18.5, 0], hidden: true },
    ],
    groups: {
      outposts: [
        guard(trackX(40) - 3.5, 38.6, S), guard(-27, 33.6, S), guard(32, 28.6, S), guard(trackX(55) + 5.5, 53.6, S),
        guard(34.6, 28.6, S), guard(-24.6, 33.6, S), patrol(-20, 40), patrol(22, 45),
      ],
      base: [
        sentry(-24, 18.5, 8, S), sentry(25, 18.5, -30, S), sentry(0, PY + 3, -27, S),
        guard(-2, 11, S), guard(14, -1, S), guard(-16, -24, E), patrol(13.5, -18), guard(-9, -9, S), guard(5, -10, S),
      ],
    },
    begin: [{ spawn: 'outposts' }, { spawn: 'base' }, { radio: 'start' }],
    alarm: [],
    objectives: [
      {
        id: 'outposts', type: 'clear', groups: ['outposts'], label: 'OUTPOSTS', text: 'Take the outposts on the slope',
        checkpoint: [55, 100, 0.45],
        done: [{ radio: 'outposts' }],
      },
      {
        id: 'breach', type: 'goto', at: [12, 8], radius: 9, label: 'GATE', text: 'Break into the firebase',
        retry: [{ spawn: 'base' }],
        checkpoint: [20, 34, 0.3],
      },
      {
        id: 'jammer', type: 'use', text: 'Plant a charge on the jammer',
        sites: [{ prop: 'jammer', label: 'JAMMER', verb: 'PLANT THE CHARGE', time: 3.5, range: 2.4 }],
        retry: [{ spawn: 'base' }],
        checkpoint: [12, 10, 0],
        done: [{ show: 'charge' }, { radio: 'charge' }],
      },
      {
        id: 'fuse', type: 'timer', time: 7, text: 'Get clear of the mast!',
        checkpoint: [12, 10, 0],
        done: [{ boom: 'jammer' }, { hide: 'charge' }, { jam: false }, { radio: 'clear', after: 1.2 }],
      },
      {
        id: 'base', type: 'clear', groups: ['base', 'outposts'], label: 'FIREBASE', text: 'Clear the firebase',
        checkpoint: [12, 10, 0],
        retry: [{ spawn: 'base' }],
        done: [{ radio: 'baseClear' }],
      },
      {
        id: 'hold', type: 'hold', at: [0, -8], radius: 27, time: 120, label: 'HOLD', text: 'Hold the hill until the relief column arrives',
        waves: { from: [[0, -72], [-22, -76], [22, -74], [-74, -12], [74, -6], [56, -58], [-58, -56]], every: 12, size: 3, max: 14, first: 5 },
        halfway: [{ radio: 'holdHalf' }],
        checkpoint: [0, -8, N],
        done: [{ radio: 'relief' }],
      },
    ],
    bonus: [
      { id: 'clean', type: 'nodeaths', text: 'Clean: nobody in the squad is killed' },
      { id: 'quick', type: 'time', minutes: 16, text: 'Quick: finish in under 16 minutes' },
    ],
    radio: {
      start: [['SHEPHERD', 'Sabre, Shepherd. The jammer is on the mast. Take the outposts and get up that hill. Do you copy?']],
      outposts: [['RAVEN', 'Outposts are down. The south gate is your way in. Raven out.']],
      charge: [['SHEPHERD', 'Charge on the jammer. Get clear of that mast!']],
      clear: [['SHEPHERD', 'There you are! Loud and clear, Sabre. The jammer is gone.'],
        ['RAVEN', 'I can see again. Everyone left on the hill is inside the base. Clear it out.']],
      baseClear: [['SHEPHERD', 'The hill is ours.'], ['RAVEN', 'Trucks coming up from the north and east. A lot of them. Here comes Kade.'],
        ['SHEPHERD', 'Relief column is two minutes out. Hold the hill.']],
      holdHalf: [['RAVEN', 'They\'re regrouping in the trees. Another push coming.']],
      relief: [['SHEPHERD', 'Relief column is on the hill. You held it, Sabre.'], ['RAVEN', 'Kade is pulling back. South, towards Mereth.']],
    },
    debrief: () => 'Kade lost the hill and most of his army with it. What\'s left of Corvane has fallen back into Mereth\'s old town, '
      + 'and Kade has made his plan clear on an open channel: if he goes down, he takes the town with him. '
      + 'The ceasefire commission wants him alive, to stand trial.',
  },

  // ===========================================================================
  // 5. LAST LIGHT — the finale: through the town at dusk, then a last stand.
  {
    id: 'last-light',
    title: 'LAST LIGHT',
    map: 'oldtown',
    time: 'DAY 5 · 19:40',
    place: 'Mereth old town',
    blurb: 'Finale. Fight through the town at dusk, take Kade, hold the square.',
    // The same late sun, but lower and redder: dusk
    atmosphere: { exposure: 0.82, sun: 0.6, fog: 1.4, env: 0.85, sight: 70, grade: { saturation: 0.88, contrast: 1.08, tint: 0xffdcbc, vignette: 0.42 } },
    briefing: {
      situation: 'Kade and his last loyal fighters hold Mereth. The townspeople are sheltering in their cellars. A relief column is fighting '
        + 'through the hills to reach the town, but it is still hours away.',
      mission: 'Come in from the north. Take the checkpoint, fight through to the market square, and find Kade. Take him alive if you can. '
        + 'Then hold the square until the relief column arrives.',
      notes: [
        'Kade wears black armour with red stripes. Raven will mark him for you.',
        'Wound him badly and he\'ll give up. Then hold F on him to restrain him.',
        'Killing him still ends the fight, but the commission wants a trial.',
      ],
    },
    start: [16, -110, 2.78],
    groups: {
      checkpoint: [guard(-2, -68.4, N), guard(1.6, -68.7, N), patrol(0, -60), sentry(-11.5, 6.25, -53.5, N), sentry(12, 6.25, -37.5, N), guard(-3, -76, N)],
      square: [
        guard(0, 3.6, N), guard(-9, -8.4, N), guard(10.5, -1.4, N), guard(-4, 14.6, N), guard(5, 15.2, N),
        sentry(-10.7, 6.25, 23, N), sentry(11, 6.25, 23, N), sentry(28, 6.25, -11.7, W), patrol(-16, 3), patrol(14, 9),
      ],
      kade: [
        guard(-9.4, 47, E, { hvt: { key: 'kade', name: 'KADE', look: LOOKS.kade, hp: 2.5, surrender: 0.4 } }),
        guard(-13, 46.5, E), guard(-5.2, 46.6, N), guard(-5.2, 40.6, N), sentry(-11, 6.25, 45, N),
      ],
    },
    begin: [{ spawn: 'checkpoint' }, { spawn: 'square' }, { radio: 'start' }, { radio: 'taunt', after: 9 }],
    alarm: [],
    triggers: [
      { when: { near: [-8, 44, 16], hvtAlive: 'kade' }, do: [{ radio: 'kadeSeen' }] },
      { when: { surrender: 'kade' }, do: [{ radio: 'surrender' }] },
    ],
    objectives: [
      {
        id: 'checkpoint', type: 'clear', groups: ['checkpoint'], label: 'CHECKPOINT', text: 'Take the north checkpoint',
        checkpoint: [16, -110, 2.78],
        done: [{ radio: 'cleared' }],
      },
      {
        id: 'square', type: 'clear', groups: ['square'], label: 'SQUARE', text: 'Clear the market square',
        retry: [{ spawn: 'square' }],
        checkpoint: [0, -62, S],
        done: [{ radio: 'square' }],
      },
      {
        id: 'kade', type: 'hvt', target: 'kade', capture: true, text: 'Find Kade. Take him alive if you can',
        start: [{ spawn: 'kade' }],
        checkpoint: [0, -6, S],
        done: [{ radio: 'kadeDone' }],
      },
      {
        id: 'hold', type: 'hold', at: [0, 2], radius: 17, time: 120, label: 'HOLD', text: 'Hold the square until the relief column arrives',
        waves: { from: [[-78, 34], [78, -34], [-74, -38], [76, 40], [0, 96], [-40, 92], [44, -94]], every: 12, size: 3, max: 14, first: 4 },
        start: [{ radio: 'hold' }],
        halfway: [{ radio: 'holdHalf' }],
        checkpoint: [0, -6, S],
        done: [{ radio: 'end' }],
      },
    ],
    bonus: [
      { id: 'alive', type: 'captured', target: 'kade', text: 'Justice: take Kade alive' },
      { id: 'clean', type: 'nodeaths', text: 'Clean: nobody in the squad is killed' },
    ],
    radio: {
      start: [['SHEPHERD', 'Sabre, Shepherd. This is the last push. The relief column is still in the hills, so it\'s you. North checkpoint first.']],
      taunt: [['WARDEN', 'CSF. You took my hill. You took my money. You will not take my town.']],
      cleared: [['RAVEN', 'Checkpoint\'s down. The square is next. They\'ve sandbagged the fountain.']],
      square: [['RAVEN', 'Square is clear. Thermal shows a group in a two-storey on the main street, south of the square, west side. '
        + 'One of them is giving the orders. That\'s Kade. Marking him now.']],
      kadeSeen: [['WARDEN', 'Come on, then! Come and get me!']],
      surrender: [['WARDEN', 'Enough! Enough. I\'m done.'], ['SHEPHERD', 'He\'s giving up, Sabre. Restrain him.']],
      kadeDone: [['SHEPHERD', 'Kade is finished. That\'s the end of Corvane.']],
      hold: [['RAVEN', 'Corvane\'s last trucks are coming in from every side. They want him back, or they want revenge.'],
        ['SHEPHERD', 'Hold the square. The relief column is two minutes out.']],
      holdHalf: [['RAVEN', 'One more push coming. Hang on.']],
      end: [['SHEPHERD', 'Relief column is in the town. Sabre... it\'s over. Come home.']],
    },
    debrief: (r) => (r.bonus.alive
      ? 'Silas Kade\'s trial opened six weeks later, with Dr. Elise Marr as the first witness and the Dustline shipping records as the evidence. '
      : 'Silas Kade never stood trial, but the Dustline records and Dr. Elise Marr\'s evidence did, and Corvane\'s owners went to prison in his place. ')
      + 'Corvane Security no longer exists. The Corran Valley ceasefire held, and slowly became a peace. FOB Pinewood is a forestry station now; '
      + 'its mast broadcasts the weather. Nobody in Mereth knows your names. That is how it should be.',
  },
];

export const missionById = (id) => MISSIONS.find((m) => m.id === id) || null;
export const missionIndex = (id) => MISSIONS.findIndex((m) => m.id === id);
