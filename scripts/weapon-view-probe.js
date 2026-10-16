(async () => {
  const bits = v => { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); return d.getUint32(0, true).toString(16).padStart(8, '0'); };
  const rows = (await window.deusExViewer.lodProbe({all: true})).filter(r => r.weapon);
  const player = (await window.deusExViewer.liveProbe({read: {names: ['@player'], props: ['Weapon', 'ViewRotation', 'Location', 'EyeHeight', 'WalkBob']}})).read['@player'];
  const name = player.Weapon;
  const actor = name ? (await window.deusExViewer.liveProbe({read: {names: ['@weapon'], props: ['Location', 'Rotation', 'AnimSequence', 'AnimFrame', 'AnimRate', 'TweenRate', 'DrawScale', 'Mesh']}})).read['@weapon'] : null;
  return {player, weapon: name, actor, bits: actor ? {location: actor.Location.map(bits), animFrame: bits(actor.AnimFrame), animRate: bits(actor.AnimRate), tweenRate: bits(actor.TweenRate)} : null,
    rows: rows.map(r => ({actor: r.actor, mesh: r.mesh, drawn: r.drawn, coords: r.frame.coordsBits.map(b => b.toString(16).padStart(8, '0')), location: r.inputs.locationBits.map(b => b.toString(16).padStart(8, '0'))}))};
})()
