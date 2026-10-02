/** Map travel is Stage 6 (docs/roadmap.md): PlayerPawn.ClientTravel (a
 * native event, called by name) would hand the URL to the engine
 * (UGameEngine's client travel, then Browse/LoadMap with the travelling
 * actors), which Play does not implement. Play stops at the call with the
 * URL, travel type and bItems the script passed, so a map that ends by
 * travelling (00_Intro's PostIntro, a mission's MapExit) ends visibly
 * instead of failing as an unknown native. */
export const TRAVEL_TYPES = Object.freeze(['TRAVEL_Absolute', 'TRAVEL_Partial', 'TRAVEL_Relative']);

export class TravelBoundary extends Error {
  constructor({ url, travelType, bItems }) {
    super(`ClientTravel("${url}", ${TRAVEL_TYPES[travelType] ?? travelType}, bItems=${bItems ? 'True' : 'False'}): map travel is Stage 6`);
    this.name = 'TravelBoundary';
    this.stage = 6;
    this.travel = Object.freeze({ url, travelType, bItems });
  }
}
