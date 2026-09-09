/** Original AddPawn529. Deliberately no duplicate guard. */
export function addPawn(level,pawn){pawn.nextPawn=level.pawnList;level.pawnList=pawn;}
/** Original RemovePawn530; removed NextPawn is deliberately retained. */
export function removePawn(level,pawn){if(level.pawnList===pawn){level.pawnList=pawn.nextPawn;return;}for(let p=level.pawnList;p;p=p.nextPawn)if(p.nextPawn===pawn){p.nextPawn=pawn.nextPawn;return;}}
