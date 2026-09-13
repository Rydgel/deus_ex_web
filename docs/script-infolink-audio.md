# InfoLink preview audio

The Training InfoLink diagnostic plays the exact startup cue and first speech
payload selected by the installed `DL_Start` conversation. This is local playback of original
game data; it does not replace or claim the original `ClientHearSound` mixer.

The reference chain is recovered from the installed packages:

- `DataLinkPlay.startSound` resolves to
  `DeusExSounds.UserInterface.DataLinkStart` export296: a 29,804-byte mono
  22,050 Hz, 16-bit PCM WAV. Its payload SHA-256 is
  `32348bd70454c713d803c84255d25e80c05a36479b3692514a99511cd6f6ee92`
  and the native RIFF period is `0.6730612516403198` seconds.
- `DataLinkPlay.StartConversation` plays that cue, starts a 0.5-second timer,
  and advances after `startTime > startDelay` with `startDelay=1.5`. The strict
  comparison reaches the first speech event at about 2.0 seconds.

- `DeusExConText.u` export 1926, `Conversation57`, has `conName=DL_Start`,
  `audioPackageName=Mission00`, and event-list export 32934.
- event 32934 points through `ConSpeech` to export 32839; its authored
  `soundID` is 79.
- native `GetSpeechAudio` therefore formats `ConAudioMission00_79` and loads it
  from `DeusExConAudioMission00.u`. The Sound is export 81.
- its serialized Sound header identifies `mp3` and owns 43,056 inline bytes.
  The payload SHA-256 is
  `f6367c840ed5988bd8d845125e67011d272799f5ec986039117c2634a8e2760c`.
- the recovered ConSys MPEG timing body returns the float32 duration
  `7.176000118255615` seconds for those bytes.

`loadInfoLinkPreviewAudio` rechecks every identity and reference before it
returns owned copies of both encoded payloads. The viewer starts a browser
audio decoder after the player's Training input, plays the cue immediately,
and schedules speech at +2.0 seconds. The transmission begins only through the
live Training trigger route.
There is no fabricated transcription, replacement clip, network request, or
asset copied outside the local session.

The original audio-device conversion, channel allocation, attenuation,
priority, pause/resume state, and `ClientHearSound` dispatch remain unsupported.
The browser plays the authored encoded bytes at its normal output level.

Focused checks:

    node scripts/validate-infolink-audio.mjs
    node scripts/validate-conversation-audio-integration.mjs
    node scripts/validate-conversation-sound-length.mjs
