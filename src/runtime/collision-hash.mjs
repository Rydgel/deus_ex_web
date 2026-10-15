// Original FCollisionHash contract and supported boundaries: docs/collision-hash.md.
const f32 = Math.fround;
const TABLE_SIZE = 16384;

function vector(value, label) {
  // Plain three-element arrays (every query path) take the unrolled form of
  // the general check below; other array-likes keep the general one.
  if (Array.isArray(value) && value.length === 3 && 0 in value && 1 in value && 2 in value) {
    const x = value[0], y = value[1], z = value[2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new TypeError(`${label} must contain three finite numbers`);
    const result = [f32(x), f32(y), f32(z)];
    if (!Number.isFinite(result[0]) || !Number.isFinite(result[1]) || !Number.isFinite(result[2])) throw new RangeError(`${label} exceeds float32`);
    return result;
  }
  if (!value || value.length !== 3 || !value.every(Number.isFinite)) throw new TypeError(`${label} must contain three finite numbers`);
  const result = value.map(f32);
  if (!result.every(Number.isFinite)) throw new RangeError(`${label} exceeds float32`);
  return result;
}

function nearestEven(value) {
  const floor = Math.floor(value);
  return value - floor < 0.5 ? floor : value - floor > 0.5 ? floor + 1 : floor + (floor % 2 !== 0 ? 1 : 0);
}

// Original X expansion retains x87's 64-bit significand across two adds.
// Tiny extents can move a float32 midpoint after JS double loses the term.
const floatBits = new DataView(new ArrayBuffer(4));
function binary(value) {
  floatBits.setFloat32(0, value, true);
  const word = floatBits.getUint32(0, true), exponent = (word >>> 23) & 255;
  return { n: BigInt((word & 0x7fffff) | (exponent ? 0x800000 : 0)) * (word >>> 31 ? -1n : 1n), e: exponent ? exponent - 150 : -149 };
}
function roundedBinary(value, precision) {
  const sign = value.n < 0n ? -1n : 1n, n = value.n * sign;
  const shift = n.toString(2).length - precision;
  if (shift <= 0) return value;
  const amount = BigInt(shift), unit = 1n << amount, half = unit >> 1n;
  let kept = n >> amount;
  const remainder = n & (unit - 1n);
  if (remainder > half || (remainder === half && (kept & 1n))) kept++;
  return { n: kept * sign, e: value.e + shift };
}
function addBinary(a, b) {
  const e = Math.min(a.e, b.e);
  return roundedBinary({ n: (a.n << BigInt(a.e - e)) + (b.n << BigInt(b.e - e)), e }, 64);
}
// Error-free TwoSum: the double sum is exact iff the rounding error is zero.
const exactSum = (a, b) => { const s = a + b, bb = s - a; return (a - (s - bb)) + (b - bb) === 0 ? s : NaN; };
function expandedXCell(coordinate, extent, sign) {
  // When both adds are exact in a double (at most 53 significant bits), the
  // two x87 64-bit roundings below are identities and the only rounding is
  // the float store of (sum / 256), which Math.fround performs identically
  // (nearest-even; the magnitude guard keeps it out of the subnormal range).
  const sum = exactSum(exactSum(coordinate, sign * extent), 32768);
  if (Math.abs(sum) >= 2 ** -100 && Math.abs(sum) < 2 ** 100) return roundedCell(f32(sum / 256));
  const amount = binary(extent); amount.n *= BigInt(sign);
  const expanded = addBinary(addBinary(binary(coordinate), amount), binary(32768));
  const stored = roundedBinary({ n: expanded.n, e: expanded.e - 8 }, 24);
  return roundedCell(f32(Number(stored.n) * 2 ** stored.e));
}

// Input may retain X's expanded-bound arithmetic until this float store.
function cell(value) {
  return roundedCell(f32((value + 32768) / 256));
}
function roundedCell(scaled) {
  let rounded = nearestEven(scaled);
  // Original masked-invalid x87 FISTP writes integer indefinite on overflow.
  if (!Number.isFinite(rounded) || rounded < -2147483648 || rounded > 2147483647) rounded = -2147483648;
  return Math.max(0, Math.min(16383, rounded));
}

export function collisionHashCell(value) {
  if (!Number.isFinite(value) || !Number.isFinite(f32(value))) throw new TypeError('Cell coordinate must be finite float32');
  return cell(f32(value));
}

export function collisionHashBounds(bounds) {
  const min = vector(bounds.min, 'bounds.min').map(cell);
  const max = vector(bounds.max, 'bounds.max').map(cell);
  return { min, max };
}

export function collisionHashLineBounds({ start, end, extent = [0, 0, 0] }) {
  start = vector(start, 'start'); end = vector(end, 'end'); extent = vector(extent, 'extent');
  const min = [expandedXCell(Math.min(start[0], end[0]), extent[0], -1),
    cell(f32(Math.min(start[1], end[1]) - extent[1])), cell(f32(Math.min(start[2], end[2]) - extent[2]))];
  const max = [expandedXCell(Math.max(start[0], end[0]), extent[0], 1),
    cell(f32(Math.max(start[1], end[1]) + extent[1])), cell(f32(Math.max(start[2], end[2]) + extent[2]))];
  return { min, max };
}

// Explicit fixture seed; actual original session RNG startup state is unknown.
export function collisionHashTables(seed) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new TypeError('An explicit uint32 RNG seed is required');
  let state = seed;
  const tables = Array.from({ length: 3 }, () => Uint32Array.from({ length: TABLE_SIZE }, (_, i) => i));
  for (let i = 0; i < TABLE_SIZE; i++) {
    for (const table of tables) {
      state = (Math.imul(state, 214013) + 2531011) >>> 0;
      const j = ((state >>> 16) & 32767) % TABLE_SIZE;
      [table[i], table[j]] = [table[j], table[i]];
    }
  }
  return tables;
}

function tag(x, y, z) { return (((z << 8) + y << 8) + x) >>> 0; }

/** Static actor registration and primitive line queries. No options selects the
 * proven seed-independent 0..255-cell domain. Explicit seed/tables select full
 * native bucket semantics; seed means a fixture state, not original startup.
 * `store` (collision-kernel.mjs KernelHashStore) keeps the buckets in the Rust
 * kernel instead of `buckets` below, in the seed-independent domain only: its
 * add/remove are these bucket writes, its candidates(cells) the order in which
 * the queries below visit registrations, and its querying word this hash's
 * `querying` flag, which the kernel's own line checks share. */
export function createCollisionHash({ tables, seed, maxCells = 1000000, store = null } = {}) {
  if (tables && seed !== undefined) throw new TypeError('Supply captured tables or a fixture seed, not both');
  if (store && (tables || seed !== undefined)) throw new TypeError('A kernel hash store has only the seed-independent domain');
  if (seed !== undefined) tables = collisionHashTables(seed);
  if (tables) {
    if (tables.length !== 3 || tables.some(t => t.length !== TABLE_SIZE || new Set(t).size !== TABLE_SIZE || [...t].some(v => !Number.isInteger(v) || v < 0 || v >= TABLE_SIZE))) throw new TypeError('Expected three original 16384-entry permutations in X,Y,Z order');
    tables = tables.map(t => Uint32Array.from(t));
  }
  if (!Number.isSafeInteger(maxCells) || maxCells < 1) throw new TypeError('maxCells must be a positive integer');
  const buckets = new Map(), registrations = new Map();
  let querying = false;
  const busy = store ? () => querying || store.querying() : () => querying;
  const setQuerying = value => { querying = value; if (store) store.setQuerying(value); };
  // The registrations a query over `cells` visits, in order, each once.
  const candidateOrder = cells => {
    if (store) return store.candidates(cells);
    const order = [], seen = new Set();
    each(cells, (bucket, packed) => {
      for (let link = buckets.get(bucket); link; link = link.next) {
        if (link.tag !== packed || seen.has(link.actor)) continue;
        seen.add(link.actor);
        order.push(link.actor);
      }
    });
    return order;
  };
  const lineQueryCells = query => {
    const args = { start: vector(query.start, 'start'), end: vector(query.end, 'end'), extent: vector(query.extent ?? [0, 0, 0], 'extent'), extraNodeFlags: (query.extraNodeFlags ?? 0) & 255 };
    const cells = collisionHashLineBounds(args); check(cells);
    return cells;
  };
  function check(cells) {
    const min = cells.min, max = cells.max;
    if (!tables && (min[0] > 255 || min[1] > 255 || min[2] > 255 || max[0] > 255 || max[1] > 255 || max[2] > 255))
      throw new RangeError('Hash cells outside proven seed-independent 0..255 domain require captured tables or an explicit fixture seed');
    const count = Math.max(0, max[0] - min[0] + 1) * Math.max(0, max[1] - min[1] + 1) * Math.max(0, max[2] - min[2] + 1);
    if (count > maxCells) throw new RangeError(`Hash operation exceeds explicit ${maxCells} cell budget`);
  }
  function each(cells, callback) {
    for (let x = cells.min[0]; x <= cells.max[0]; x++) for (let y = cells.min[1]; y <= cells.max[1]; y++) for (let z = cells.min[2]; z <= cells.max[2]; z++) {
      const packed = tag(x, y, z);
      callback(tables ? tables[0][x] ^ tables[1][y] ^ tables[2][z] : packed, packed);
    }
  }
  return {
    mode: tables ? 'explicit-tables' : 'seed-independent-0..255',
    addActor(actor, bounds, { collideActors = true, objectFlags = actor.objectFlags ?? 0, actorFlags = actor.actorFlags ?? objectFlags, location = actor.location ?? [0, 0, 0] } = {}) {
      if (busy()) throw new Error('Hash mutation during primitive queries is unsupported');
      if (!collideActors) throw new Error('Original AddActor requires bCollideActors');
      if (actorFlags & 0x80) return null;
      if (registrations.has(actor)) throw new Error('Actor is already registered');
      const cells = collisionHashBounds(bounds); check(cells);
      const hashLocation = vector(location, 'location');
      if (store) store.add(actor, cells);
      else each(cells, (bucket, packed) => buckets.set(bucket, { actor, tag: packed, next: buckets.get(bucket) }));
      const registration = { cells, hashLocation };
      registrations.set(actor, registration);
      return { cells: { min: [...cells.min], max: [...cells.max] }, hashLocation: [...hashLocation] };
    },
    removeActor(actor, bounds, { collideActors = true, objectFlags = actor.objectFlags ?? 0, actorFlags = actor.actorFlags ?? objectFlags, location } = {}) {
      if (busy()) throw new Error('Hash mutation during primitive queries is unsupported');
      if (!collideActors) throw new Error('Original RemoveActor requires bCollideActors');
      if (actorFlags & 0x80) return false;
      const registration = registrations.get(actor);
      if (!registration) return false;
      if (location && vector(location, 'location').some((v, i) => v !== registration.hashLocation[i])) throw new Error('Remove actor before changing its registered location');
      const cells = bounds ? collisionHashBounds(bounds) : registration.cells;
      if ([...cells.min, ...cells.max].some((v, i) => v !== [...registration.cells.min, ...registration.cells.max][i])) throw new Error('Remove actor before changing its registered bounds');
      if (store) store.remove(actor, cells);
      else each(cells, bucket => {
        let head = buckets.get(bucket), previous;
        for (let link = head; link; link = link.next) {
          if (link.actor === actor) {
            if (previous) previous.next = link.next;
            else head = link.next;
          } else previous = link;
        }
        if (head) buckets.set(bucket, head); else buckets.delete(bucket);
      });
      registrations.delete(actor);
      return true;
    },
    actorPointCheck({position,extent=[0,0,0]},primitivePointCheck) {
      //103585cb–1035871c uses the same cell expansion/stores as a stationary
      //line query.10358809 always supplies zero primitive extra flags.
      return this.actorLineCheck({start:position,end:position,extent,extraNodeFlags:0},
        (actor,args)=>primitivePointCheck(actor,{position:args.start,extent:args.extent,extraNodeFlags:0}));
    },
    actorEncroachmentCheck({bounds},primitiveCheck) {
      if(busy())throw Error('Nested collision hash queries are unsupported');
      const cells=collisionHashBounds(bounds);check(cells);
      const visited=new Set(),hits=[];
      if(store){
        const candidates=store.candidates(cells);setQuerying(true);
        try{for(const actor of candidates){const hit=primitiveCheck(actor);if(hit!==null&&hit!==undefined)hits.push(hit);}}
        finally{setQuerying(false);}
        return hits;
      }
      querying=true;
      try{each(cells,(bucket,packed)=>{
        for(let link=buckets.get(bucket);link;link=link.next){
          if(visited.has(link.actor)||link.tag!==packed)continue;
          visited.add(link.actor);
          const hit=primitiveCheck(link.actor);
          if(hit!==null&&hit!==undefined)hits.push(hit);
        }
      });}finally{querying=false;}
      //10358fc2 appends at the tail instead of prepending point/ray hits.
      return hits;
    },
    actorLineCheck(query, primitiveLineCheck) {
      if (busy()) throw new Error('Nested collision hash queries are unsupported');
      if (typeof primitiveLineCheck !== 'function') throw new TypeError('An evidenced primitive callback is required');
      const args = { start: vector(query.start, 'start'), end: vector(query.end, 'end'), extent: vector(query.extent ?? [0, 0, 0], 'extent'), extraNodeFlags: (query.extraNodeFlags ?? 0) & 255 };
      const cells = collisionHashLineBounds(args); check(cells);
      if (store) {
        const candidates = store.candidates(cells), hits = [];
        setQuerying(true);
        try {
          for (const actor of candidates) {
            const hit = primitiveLineCheck(actor, args);
            if (hit !== null && hit !== undefined) hits.push(hit);
          }
        } finally { setQuerying(false); }
        return hits.reverse();
      }
      // Few actors share a line's cells: a short list, then a Set, records
      // those already checked (each actor is checked once, in cell order).
      let visited = [];
      const hits = [], min = cells.min, max = cells.max;
      querying = true;
      try {
        for (let x = min[0]; x <= max[0]; x++) for (let y = min[1]; y <= max[1]; y++) for (let z = min[2]; z <= max[2]; z++) {
          const packed = tag(x, y, z), bucket = tables ? tables[0][x] ^ tables[1][y] ^ tables[2][z] : packed;
          for (let link = buckets.get(bucket); link; link = link.next) {
            if (link.tag !== packed) continue;
            const actor = link.actor;
            if (Array.isArray(visited)) {
              if (visited.includes(actor)) continue;
              visited.push(actor);
              if (visited.length > 32) visited = new Set(visited);
            } else {
              if (visited.has(actor)) continue;
              visited.add(actor);
            }
            // Null means the primitive reported clear; every other result is a hit.
            const hit = primitiveLineCheck(actor, args);
            if (hit !== null && hit !== undefined) hits.push(hit);
          }
        }
      } finally { querying = false; }
      return hits.reverse();
    },
    /** The registrations actorLineCheck(query) would visit, in its order,
     * after the same argument checks (the collision-kernel differential). */
    lineCandidates(query) {
      return candidateOrder(lineQueryCells(query));
    },
    /** The registrations a query over explicit cells visits (ActorRadiusCheck's cell box,
     * collision-hash-radius.mjs), in its order, each once. */
    cellCandidates(cells) {
      check(cells);
      return candidateOrder(cells);
    },
    /** The registrations actorEncroachmentCheck({bounds}) would visit. */
    boundsCandidates({ bounds }) {
      const cells = collisionHashBounds(bounds); check(cells);
      return candidateOrder(cells);
    },
  };
}
