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
    // Stock class: DeusEx.Businessman2 (HumanCivilian, mesh GM_Suit: jacket, trousers, head; its glasses and ponytail parts stay hidden by the class's own masks).
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
    // The hidden seat sits on the floor at the crate's centre; its first sit point is derived (easter-sim.mjs) so the pose's seat plane
    // meets the crate's top surface: `hipDrop` is the distance from the mesh origin (Location + PrePivot) down to the lowest seat vertex of
    // GFM_TShirtPants' SitBreathe frame, (11000 - 6193) / 256 on the mesh's origin and scale, and `lidEmbed` how far under the lid's
    // top that plane is put (no visible gap).
    hipDrop: 18.78,
    lidEmbed: 0.3,
    // The same frame's extents forward of the origin (the mesh's -y, (raw y) / -256): the heels 15.0, the toes and knees to 26.6, the back of the hips
    // 3.9 behind it. The validator checks the heels clear the crate's front face and the hips stay on the lid with these.
    heelForward: 15.0,
    hipBack: 3.9,
    seatRadius: 40,
    // Her sit point is moved this far toward the room (her facing) from the crate's centre, so she sits on the front part of the lid
    // and her lower legs hang in front of the crate's front face (x = crate.x + 34) instead of through it: measured on GFM_TShirtPants'
    // SitBreathe frame (docs/easter-egg.md "Her seat"), the heels are 15 and the knees and toes 21 to 27 units in front of the pose's
    // origin, the back of her hips 4 behind it.
    sitForward: 24,
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

/** Spoken voices (docs/easter-egg.md "Voices"): synthesised once by scripts/easter-voices.mjs with Piper from these rhasspy/piper-voices
 * models (both datasets are public domain, LibriVox recordings; the repository is MIT) and committed as MP3 clips under
 * src/viewer/easter-audio/. The models themselves are never committed. Nothing here is original game data. */
export const EASTER_VOICES = Object.freeze({
  revision: 'c10ece1aade47bb51c153c893d14e5bf8e5b7117',
  speakers: Object.freeze({
    // Claudia: US English female, one speaker, trained from scratch on about 11.5 h of LibriVox.
    claudia: Object.freeze({ voice: 'en_US-kristin-medium', path: 'en/en_US/kristin/medium', license: 'public domain (LibriVox)',
      onnxSha256: '5849957f929cbf720c258f8458692d6103fff2f0e3d3b19c8259474bb06a18d4', jsonSha256: '5681426d4aead22195de70531eeeeddb46493cfaffc5764b2ea3db73428b651c' }),
    // Rydgel: US English male, one speaker, trained from scratch on about 15.5 h of LibriVox.
    rydgel: Object.freeze({ voice: 'en_US-norman-medium', path: 'en/en_US/norman/medium', license: 'public domain (LibriVox)',
      onnxSha256: 'b9739443232a80a59c7d18810dd856899bf16a7964725f5ab81ea49b1351cb71', jsonSha256: '6c2db7f558a4a8deb9fe822583c1c5105f6c4e834dd0f9de8ad17a888ee9fe1d' }),
  }),
});

/** Every spoken line: `frob-<who>-<i>` is `who`'s i-th frob line (said by `who`), `reply-<who>-<i>` the answer to it (said by the other).
 * The id names the clip file (easter-audio/<id>.mp3) and, as `easter.<id>`, the speech sound the mod plays. */
export function easterClips() {
  const other = who => (who === 'claudia' ? 'rydgel' : 'claudia');
  const clips = [];
  for (const who of ['claudia', 'rydgel'])
    EASTER.pairs[who].forEach(([line, reply], i) => {
      clips.push({ id: `frob-${who}-${i}`, kind: 'frob', frobbed: who, index: i, speaker: who, text: line });
      clips.push({ id: `reply-${who}-${i}`, kind: 'reply', frobbed: who, index: i, speaker: other(who), text: reply });
    });
  return clips;
}
