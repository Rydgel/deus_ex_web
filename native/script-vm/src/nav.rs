//! FindPathToward's open-list search over the object image: the JavaScript
//! `navSearchBFS` (script-pawn-nav.mjs, Engine.dll 0x103dcd..0x103dd034,
//! docs/script-pawn-nav.md), statement for statement, on the NavigationPoint
//! fields its reads and writes name. The JavaScript body stays the reference
//! (NAV_SEARCH=js) and the comparison (NAV_SEARCH=verify, script-vm-nav.mjs).
//!
//! The host fills the field table ([offset, bool mask, key id] per N_*) and,
//! per level, the ReachSpec table: [radius, height, reachFlags, distance,
//! start handle] per spec, in the level's order. A node is read through its
//! receiver info (image base) at the table's offsets; the host checks that
//! every NavigationPoint class of the level stores these fields in the image
//! at those offsets before it calls `nav_search`.

use crate::interp::{bound_key, live, load32, receiver, store32, BOUND, HOST};
use crate::x87::Ext;
use core::ptr::addr_of_mut;

const N_VISITEDWEIGHT: usize = 0;
const N_NEXTORDERED: usize = 1;
const N_PREVORDERED: usize = 2;
const N_PREVIOUSPATH: usize = 3;
const N_COST: usize = 4;
const N_BENDPOINT: usize = 5;
const N_BESTPATHWEIGHT: usize = 6;
const N_BPLAYERONLY: usize = 7;
const N_UPSTREAMPATHS: usize = 8;
const N_NEXTNAVIGATIONPOINT: usize = 9;
// navScoutA's reset and distance reads (`nav_scout`).
const N_LOCATION: usize = 10;
const N_BSPECIALCOST: usize = 11;
const N_EXTRACOST: usize = 12;
const FIELD_COUNT: usize = 13;

static mut N_FIELDS: [[u32; 3]; FIELD_COUNT] = [[0; 3]; FIELD_COUNT];

#[no_mangle]
pub extern "C" fn nav_fields_ptr() -> *mut u32 {
    addr_of_mut!(N_FIELDS) as *mut u32
}

#[inline(always)]
fn nfield(field: usize) -> [u32; 3] {
    unsafe { (*addr_of_mut!(N_FIELDS))[field] }
}

/// `nav_search` results.
const NOT_FOUND: u32 = 0;
const FOUND: u32 = 1;
/// A node the image cannot answer (a host receiver, a bound key): nothing
/// was written, the JavaScript body runs.
const HANDBACK: u32 = 2;
/// A spec whose start is None, or a node outside the checked set, reached
/// mid-search: the JavaScript body would throw at the same read.
const FAULT: u32 = 3;

/// The chain walk's bound (a cycle in nextNavigationPoint would never end).
const CHAIN_LIMIT: u32 = 1 << 16;

/// A node's image base, or 0 when the image does not answer its nav fields.
fn base(handle: u32) -> u32 {
    let (info, bind) = receiver(handle);
    if info & HOST != 0 || info & !15 == 0 {
        return 0;
    }
    if info & BOUND != 0 {
        for i in 0..FIELD_COUNT {
            if bound_key(bind, nfield(i)[2]) {
                return 0;
            }
        }
    }
    info & !15
}

struct Node(u32);

impl Node {
    #[inline(always)]
    fn at(&self, field: usize) -> u32 {
        self.0.wrapping_add(nfield(field)[0])
    }
    fn int(&self, field: usize) -> i32 {
        load32(self.at(field)) as i32
    }
    fn set_int(&self, field: usize, value: i32) {
        store32(self.at(field), value as u32)
    }
    fn flag(&self, field: usize) -> bool {
        load32(self.at(field)) & nfield(field)[1] != 0
    }
    /// A pointer as readNamed yields it: a released handle is None.
    fn pointer(&self, field: usize) -> u32 {
        live(load32(self.at(field)))
    }
    fn set_pointer(&self, field: usize, handle: u32) {
        store32(self.at(field), handle)
    }
    fn upstream(&self, i: u32) -> i32 {
        load32(self.at(N_UPSTREAMPATHS).wrapping_add(4 * i)) as i32
    }
    fn set_flag(&self, field: usize, value: bool) {
        let at = self.at(field);
        let mask = nfield(field)[1];
        store32(at, if value { load32(at) | mask } else { load32(at) & !mask })
    }
    /// Location's float bits, element `i`.
    fn location(&self, i: u32) -> u32 {
        load32(self.at(N_LOCATION).wrapping_add(4 * i))
    }
}

struct Search {
    specs: u32,
    count: u32,
}

impl Search {
    /// The node of `handle`, or None for a node the image does not answer.
    fn node(&self, handle: u32) -> Option<Node> {
        let b = base(handle);
        if b == 0 {
            None
        } else {
            Some(Node(b))
        }
    }
    fn spec(&self, index: u32, word: u32) -> u32 {
        load32(self.specs.wrapping_add(20 * index).wrapping_add(4 * word))
    }
}

/// Whether every node the search can reach answers in the image: the
/// level's NavigationPointList chain from `head`, `start` and every spec's
/// start. Read only, so a false answer leaves the JavaScript body to run.
fn answerable(search: &Search, head: u32, start: u32) -> bool {
    if search.node(start).is_none() {
        return false;
    }
    for i in 0..search.count {
        let s = search.spec(i, 4);
        if s != 0 && search.node(s).is_none() {
            return false;
        }
    }
    let mut node = head;
    let mut steps = 0;
    while node != 0 {
        let Some(n) = search.node(node) else { return false };
        node = n.pointer(N_NEXTNAVIGATIONPOINT);
        steps += 1;
        if steps > CHAIN_LIMIT {
            return false;
        }
    }
    true
}

/// navSearchBFS(pawn, start, foundPtr, bSinglePath, mask) with the pawn's
/// truncated CollisionRadius `cri`, CollisionHeight `chi` and flag word
/// `f318` (+0x318); `head` is LevelInfo.NavigationPointList. On FOUND the
/// endpoint's handle is stored at `out`.
#[no_mangle]
pub extern "C" fn nav_search(
    specs: u32,
    count: u32,
    head: u32,
    start: u32,
    cri: i32,
    chi: i32,
    f318: u32,
    single: u32,
    mask: i32,
    out: u32,
) -> u32 {
    let search = Search { specs, count };
    if !answerable(&search, head, start) {
        return HANDBACK;
    }
    macro_rules! node {
        ($h:expr) => {
            match search.node($h) {
                Some(n) => n,
                None => return FAULT,
            }
        };
    }
    let start_node = node!(start);
    let mut head = start;
    let mut n_ins: i32 = 1;
    let mut advanced: i32 = 0;
    let mut pops: i32 = 0;
    let mut cur = start;
    while cur != 0 {
        let c = node!(cur);
        if c.flag(N_BENDPOINT) {
            start_node.set_pointer(N_PREVIOUSPATH, 0);
            store32(out, cur);
            return FOUND;
        }
        let skip = c.flag(N_BPLAYERONLY) && f318 & 0x2 == 0 && cur != start;
        if !skip {
            for i in 0..16 {
                let idx = c.upstream(i);
                if idx == -1 {
                    break;
                }
                // `table[idx]` is undefined outside the table.
                if idx < 0 || idx as u32 >= search.count {
                    continue;
                }
                let index = idx as u32;
                if (search.spec(index, 0) as i32) < cri {
                    continue;
                }
                if (search.spec(index, 1) as i32) < chi {
                    continue;
                }
                let flags = search.spec(index, 2) as i32;
                if flags & mask != flags {
                    continue;
                }
                let cand_handle = search.spec(index, 4);
                if cand_handle == 0 {
                    return FAULT;
                }
                let cand = node!(cand_handle);
                let end_weight = if cand.flag(N_BENDPOINT) { cand.int(N_BESTPATHWEIGHT) } else { 0 };
                let new_cost = c
                    .int(N_VISITEDWEIGHT)
                    .wrapping_add(search.spec(index, 3) as i32)
                    .wrapping_add(cand.int(N_COST))
                    .wrapping_add(end_weight);
                if cand.int(N_VISITEDWEIGHT) <= new_cost {
                    continue;
                }
                // Unlink the candidate from the open list when it is already linked.
                let p = cand.pointer(N_PREVORDERED);
                if p != 0 {
                    let n = cand.pointer(N_NEXTORDERED);
                    let pn = node!(p);
                    pn.set_pointer(N_NEXTORDERED, n);
                    if n != 0 {
                        node!(n).set_pointer(N_PREVORDERED, p);
                    }
                    if head == cand_handle {
                        if pn.int(N_VISITEDWEIGHT) > new_cost {
                            head = p;
                        }
                    } else {
                        let head_weight = node!(head).int(N_VISITEDWEIGHT);
                        if cand.int(N_VISITEDWEIGHT) > head_weight && new_cost < head_weight {
                            n_ins = n_ins.wrapping_sub(1);
                        }
                    }
                } else if new_cost <= node!(head).int(N_VISITEDWEIGHT) {
                    n_ins = n_ins.wrapping_add(1);
                }
                cand.set_pointer(N_PREVIOUSPATH, cur);
                cand.set_int(N_VISITEDWEIGHT, new_cost);
                // Sorted reinsertion after pos = (head.vW < newCost) ? head : cur.
                let mut pos = if node!(head).int(N_VISITEDWEIGHT) < new_cost { head } else { cur };
                let mut walk = 0;
                let mut nxt;
                loop {
                    nxt = node!(pos).pointer(N_NEXTORDERED);
                    if nxt == 0 || node!(nxt).int(N_VISITEDWEIGHT) >= new_cost {
                        break;
                    }
                    pos = nxt;
                    walk += 1;
                    if walk > 500 {
                        return NOT_FOUND;
                    }
                }
                if nxt != cand_handle {
                    let pos_node = node!(pos);
                    let after = pos_node.pointer(N_NEXTORDERED);
                    cand.set_pointer(N_NEXTORDERED, after);
                    cand.set_pointer(N_PREVORDERED, pos);
                    pos_node.set_pointer(N_NEXTORDERED, cand_handle);
                    if after != 0 {
                        node!(after).set_pointer(N_PREVORDERED, cand_handle);
                    }
                }
            }
            // Lazy head advance at ftol(nIns*0.5) steps (0x103dcfd2-0x103dcfff):
            // the product is exact and _ftol truncates.
            n_ins = n_ins.wrapping_add(1);
            let cap = (n_ins as f64 * 0.5) as i64 as i32;
            while advanced < cap {
                advanced += 1;
                let n = node!(head).pointer(N_NEXTORDERED);
                if n != 0 {
                    head = n;
                }
            }
        }
        pops += 1;
        if single != 0 && pops > 4 {
            return NOT_FOUND;
        }
        if pops > 1000 {
            return NOT_FOUND;
        }
        cur = node!(cur).pointer(N_NEXTORDERED);
    }
    NOT_FOUND
}

/// navDistSq: the int32 key 0x10413652 `__ftol`s from the 80-bit sum of the
/// squared float32 deltas.
fn dist_sq(a: [u32; 3], b: [u32; 3]) -> i32 {
    let d = |i: usize| Ext::load(a[i]).add(Ext::load(b[i]).neg());
    let (dx, dy, dz) = (d(0), d(1), d(2));
    dx.mul(dx).add(dy.mul(dy)).add(dz.mul(dz)).ftol()
}

/// navInsert (sortedInsert 0x103dd170) on a [count, items[32], keys[32]]
/// list at `list`.
fn insert(list: u32, item: u32, key: i32) {
    let n = load32(list);
    let items = list.wrapping_add(4);
    let keys = list.wrapping_add(132);
    let mut i = 0;
    while i < n && (load32(keys.wrapping_add(4 * i)) as i32) < key {
        i += 1;
    }
    if i >= 32 {
        return;
    }
    let count = (n + 1).min(32);
    let mut j = count - 1;
    while j > i {
        store32(items.wrapping_add(4 * j), load32(items.wrapping_add(4 * (j - 1))));
        store32(keys.wrapping_add(4 * j), load32(keys.wrapping_add(4 * (j - 1))));
        j -= 1;
    }
    store32(items.wrapping_add(4 * i), item);
    store32(keys.wrapping_add(4 * i), key as u32);
    store32(list, count);
}

/// `nav_scout` results: the chain is done, or the scan stopped before the
/// node stored at `out` (its iteration runs in JavaScript: a bSpecialCost
/// node's SpecialCost event, or a node the image does not answer).
const SCOUT_DONE: u32 = 0;
const SCOUT_STOPPED: u32 = 1;

/// navScoutA's loop over the NavigationPointList chain from `node`
/// (0x103da2f4..): with `clear`, each node's ordering fields are reset,
/// bEndPoint cleared, visitedWeight set to 10000000 and cost to ExtraCost;
/// unless `anchor`, a node within distSq 640000 of the pawn location at
/// `ploc` joins the list at `this_list`; unless `seeded`, one within 640000
/// of the target location at `tloc` joins `other_list`. Locations are three
/// float32 bit words.
#[no_mangle]
pub extern "C" fn nav_scout(
    node: u32,
    clear: u32,
    anchor: u32,
    seeded: u32,
    ploc: u32,
    tloc: u32,
    this_list: u32,
    other_list: u32,
    out: u32,
) -> u32 {
    let read3 = |at: u32| [load32(at), load32(at.wrapping_add(4)), load32(at.wrapping_add(8))];
    let (pawn, target) = (read3(ploc), read3(tloc));
    let mut nav = node;
    let mut steps = 0;
    while nav != 0 {
        let b = base(nav);
        steps += 1;
        if b == 0 || steps > CHAIN_LIMIT {
            store32(out, nav);
            return SCOUT_STOPPED;
        }
        let n = Node(b);
        if clear != 0 {
            if n.flag(N_BSPECIALCOST) {
                store32(out, nav);
                return SCOUT_STOPPED;
            }
            n.set_pointer(N_NEXTORDERED, 0);
            n.set_pointer(N_PREVORDERED, 0);
            n.set_flag(N_BENDPOINT, false);
            n.set_int(N_VISITEDWEIGHT, 10000000);
            n.set_int(N_COST, n.int(N_EXTRACOST));
        }
        let location = [n.location(0), n.location(1), n.location(2)];
        if anchor == 0 {
            let key = dist_sq(pawn, location);
            if key < 640000 {
                insert(this_list, nav, key);
            }
        }
        if seeded == 0 {
            let key = dist_sq(target, location);
            if key < 640000 {
                insert(other_list, nav, key);
            }
        }
        nav = n.pointer(N_NEXTNAVIGATIONPOINT);
    }
    SCOUT_DONE
}
