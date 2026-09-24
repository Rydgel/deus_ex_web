import {parseIniValue} from '../unreal/user-config.mjs';

/** Script-visible local viewport prefix. Native construction order and the
 * intentionally unsupported platform tail: docs/script-viewport-console.md. */
export async function attachLocalViewportConsole({runtime,assets,engine,viewport,player}) {
  const ini=assets.configFiles.find(file=>/(^|\/)deusex\.ini$/i.test(file.path.replaceAll('\\','/')));
  if(!ini)throw new Error('Local Console requires DeusEx.ini Engine.Engine.Console');
  const consoleName=parseIniValue(new TextDecoder('latin1').decode(await ini.read()),'Engine.Engine','Console');
  if(consoleName?.toLowerCase()!=='engine.console')
    throw new Error(`Local Console class construction is unsupported: ${consoleName}`);
  const playerClass=await runtime.loadClass(engine,engine.exportsByPath.get('player'));
  const consoleClass=await runtime.loadClass(engine,engine.exportsByPath.get('console'));
  const graph=runtime.classLoader.graph;
  const native=graph.staticRecords.get('Engine.Viewport');
  if(graph.superOf(native)!==playerClass.loadRecord)
    throw new Error('Original Viewport superclass must be Player');
  // Native-only Viewport has no script export or own script members. Use its
  // canonical native identity with the loaded Player prefix; do not fabricate
  // an Engine.u export or claim to construct the WindowsViewport tail.
  const viewportClass={record:runtime.classLoader.identity(native),base:playerClass,
    metadata:playerClass.metadata,fields:new Map(),methods:new Map(),states:new Map(),
    stateOrder:[],propertyOrder:[],propertyLink:playerClass.propertyLink,
    destructorLink:playerClass.destructorLink,defaults:new Map(playerClass.defaults)};
  runtime.attach(viewport,viewportClass);
  const actorField=runtime.lookupMember(playerClass,'fields','Actor');
  runtime.bindProperty(viewport,actorField,{get:()=>viewport.actor,set:value=>{viewport.actor=value;}});
  const console={name:'Console',kind:'Console'};
  runtime.attach(console,consoleClass);
  const set=(object,name,value)=>runtime.namedReference(object,name).set(value);
  set(viewport,'Console',console);
  // UConsole::_Init, following class-default construction. attach initializes
  // the no-state script frame used by the original InitExecution virtual.
  for(const [name,offset,value] of [['Viewport',0x2c,viewport],['TopLine',0x110,63],['BorderSize',0x720,1]]) {
    const field=runtime.lookupMember(consoleClass,'fields',name);
    if(graph.slotOf(field.loadRecord,0x48)!==offset)throw new Error(`Console field offset changed: ${name}`);
    set(console,name,value);
  }
  set(viewport,'Actor',player);
  set(player,'Player',viewport);
  return console;
}
