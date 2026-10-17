/** The ?easter=1 mod's spoken lines, simulation side (docs/easter-egg.md "Voices"). Imported only by easter-sim.mjs, so a page without
 * the flag never loads it.
 *
 * A clip plays as the speech of its speaker actor through the game's own speech path, the one ConPlay.PlaySpeech takes:
 *   Actor.PlaySound(Sound, SLOT_Talk, , , radius) (native 264, script-sound.mjs execActorPlaySound: CheckHearSound, the player's
 *   ClientHearSound) -> Galaxy's PlaySound -> a channel on the speaker -> Update's voice (MPEG sample, the page decodes the bytes
 *   like a speech MP3 of the game's own packages, the ring transport plays it) and, for a Talk-slot channel whose Pawn bIsSpeaking,
 *   step 12's lip-sync analysis writes the speaker's nextPhoneme (docs/lip-sync.md).
 * What the original does around that and what is ours here:
 *   - ConPlay.StartSpeakingAnimation sets bIsSpeaking and bWasSpeaking on the speaker; StopSpeakingAnimation clears bIsSpeaking.
 *     The same two writes bracket a clip (the original function bodies are bytecode on a ConPlay actor, which this mod never spawns).
 *   - Pawn.LipSynch(deltaTime) maps nextPhoneme to a Mouth* blend animation. The original calls it from the Tick of ScriptedPawn's
 *     Conversation states; these pawns stand in Sitting/Standing, so the mod calls the original LipSynch body after each level tick
 *     while the clip plays (and once after, which closes the mouth) with the level's delta. The letters take effect one tick after
 *     they are written, as in the original (Audio->Update runs after the level tick).
 *   - The radius is BarkManager.StartBark's 1024 (an ambient exchange, not a camera conversation).
 *   - The Galaxy channel id needs the speaker's global object index. A spawned pawn has none the runtime measured; unless the
 *     object-index model has one (runtime.soundObjectIndex) the mod gives each speaker a fixed index far above any real one, used
 *     only to key its channel (not an original index).
 * The sounds are synthetic Sound objects (no package export) registered in script-audio-live.mjs's `moddedSounds`. */
import { moddedSounds } from '../runtime/script-audio-live.mjs';
import { execActorPlaySound } from '../runtime/script-sound.mjs';
import { mp3Frames, mp3SampleRate } from '../runtime/galaxy-lipsync-channels.mjs';
import { easterClips } from './easter-config.mjs';

const SLOT_TALK = 5;
const SPEECH_RADIUS = 1024;
const MOD_OBJECT_INDEX = 0x00fe0000;

let clips = null;

/** The 12 clips, fetched once per simulation (the Sound objects stay the same across a Player start so Galaxy's registry keeps one
 * record per clip). Resolves to a Map by clip id: {id, kind, frobbed, index, speaker, text, sound, bytes, seconds}. */
export async function loadClips() {
  if (clips) return clips;
  const loaded = new Map();
  for (const clip of easterClips()) {
    const response = await fetch(new URL(`./easter-audio/${clip.id}.mp3`, import.meta.url));
    if (!response.ok) throw new Error(`easter: clip ${clip.id} (HTTP ${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const rate = mp3SampleRate(bytes), frames = mp3Frames(bytes);
    if (!rate || !frames) throw new Error(`easter: clip ${clip.id} has no MPEG frames`);
    const sound = { kind: 'Sound', key: `easter.${clip.id}`, name: `easter_${clip.id}` };
    moddedSounds.set(sound, bytes);
    loaded.set(clip.id, { ...clip, sound, bytes, seconds: frames / rate });
  }
  return (clips = loaded);
}

/** Actor.PlaySound(clip.sound, SLOT_Talk, , , 1024) on the speaker through the original execPlaySound. Returns its channel id. */
export function playSpeech(runtime, speaker, sound, speakers) {
  const args = [sound, SLOT_TALK, undefined, undefined, SPEECH_RADIUS];
  const call = { receiver: speaker, argumentCount: args.length, evaluateArgument: index => args[index], script: null };
  const services = runtime.playSoundServices(call), read = services.read;
  services.read = (actor, name) => {
    if (name === 'ObjectIndex' && runtime.soundObjectIndex(actor) === null && speakers.has(actor)) return MOD_OBJECT_INDEX + speakers.get(actor);
    return read(actor, name);
  };
  const result = execActorPlaySound(call, services);
  return result.resultWritten ? result.result : null;
}

/** The Galaxy channel (if any) that holds the clip for its speaker. */
export function speechChannel(runtime, speaker, sound) {
  return runtime.audio?.galaxy?.state.channels.find(channel => channel.actor === speaker && channel.sound === sound) ?? null;
}

/** ConPlay.StartSpeakingAnimation / StopSpeakingAnimation on the speaker. */
export function setSpeaking(runtime, speaker, speaking) {
  if (speaking) { runtime.writeNamed(speaker, 'bIsSpeaking', true); runtime.writeNamed(speaker, 'bWasSpeaking', true); }
  else runtime.writeNamed(speaker, 'bIsSpeaking', false);
}

/** The original Pawn.LipSynch(deltaTime) body (Pawn.uc), run on the speaker. */
export function lipSynch(runtime, speaker, deltaTime) {
  const seconds = Math.fround(deltaTime);
  runtime.callFunction(runtime.lookup(speaker, 'LipSynch'), speaker, 1, () => seconds);
}
