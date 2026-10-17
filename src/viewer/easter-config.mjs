/** The ?easter=1 mod's data in one place (docs/easter-egg.md): the two NPCs' names, classes, spot and lines. Edit the names
 * here; the HUD shows them through the pawns' own FamiliarName/UnfamiliarName (DeusExPlayer.GetDisplayName) and the frob
 * lines and banter use them as speakers. Nothing here is original data: the placement was measured in 10_Paris_Club's
 * collision (docs/easter-egg.md "Where they stand") and the classes are stock DeusEx.u pawn and decoration classes. */
export const EASTER = Object.freeze({
  map: '10_Paris_Club',
  claudia: Object.freeze({
    name: 'Claudia',
    // Stock class: DeusEx.Female1 (HumanCivilian, mesh GFM_TShirtPants), the class of this map's own Female0.
    pawnClass: 'Female1',
    // Her seat on the crate: a Chair1 (a stock Seat) kept hidden on the lid so ScriptedPawn.Sitting runs its own
    // sit-down, SitBreathe loop and stasis rules on it.
    seatClass: 'Chair1',
    crateClass: 'CrateBreakableMedGeneral',
  }),
  rydgel: Object.freeze({
    name: 'Rydgel',
    // Stock class: DeusEx.Businessman2 (HumanCivilian, mesh GM_Suit: jacket, trousers, head, glasses and ponytail slots).
    pawnClass: 'Businessman2',
  }),
  // Measured on 10_Paris_Club's collision: the bar counter's front plane is x = -1127.5 (top z = -143.5) and the floor in front
  // of it, z = -191.5, runs to a 16 unit step at x = -1008.5; the walls are at y = -639.5 and y = -128.5.
  place: Object.freeze({
    floor: -191.5,
    crate: Object.freeze({ x: -1090, y: -388, yaw: 0 }),
    // Both face the room (+x); Rydgel leans on the counter's front beside her crate. ScriptedPawn.Sitting turns a seated pawn
    // to Seat.Rotation + (0,-16384,0), so the hidden seat is yawed a quarter turn from her facing.
    rydgel: Object.freeze({ x: -1104, y: -448, yaw: 0 }),
    claudiaYaw: 0,
    // The hidden seat sits on the floor at the crate's centre; its sit point is raised by `sitLift` (the crate's height, tuned on
    // screen) and its collision radius is `seatRadius` so Sitting's approach point is clear of the crate (docs/easter-egg.md).
    sitLift: 28,
    seatRadius: 40,
  }),
  // The line a frob shows is `Name: line`; the other answers `replyDelay` seconds later (level time). Each pair is
  // [line of the one frobbed, the other's answer]; a speaker's pairs come in turn, the first one on the first frob.
  replyDelay: 1.6,
  pairs: Object.freeze({
    claudia: Object.freeze([
      ["Shh, I'm chasing one last ulp.", "She said that an hour ago. Don't tell her I noticed."],
      ['Three bits off. Three. I can feel it.', "That's how it starts. Then it's sunrise."],
      ['Tell Rydgel the build is green. Do not tell him why.', 'I heard that.'],
    ]),
    rydgel: Object.freeze([
      ["Push when it's good.", "It's not good yet."],
      ["Bar's open. Mind the crate.", 'The crate is load-bearing.'],
      ['We built this place. Mostly she built it.', 'He held the ladder. It counts.'],
    ]),
  }),
});
