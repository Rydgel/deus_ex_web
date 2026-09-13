import {scriptCaps,scriptNameToString} from './script-string-operations.mjs';

/** Core 1013ece0. node is the native StateNode, including a class sentinel;
 * null means there is no frame or node. See docs/script-state-queries.md. */
export function scriptIsInState(node,name) {
  const key=scriptCaps(scriptNameToString(name));
  const seen=new Set();
  for(;node;node=node.base){
    if(seen.has(node))throw new Error('Cyclic native state superclass chain');
    seen.add(node);
    if(scriptCaps(scriptNameToString(node.record.name))===key)return true;
  }
  return false;
}

/** Core 1013edb0. No inherited-state search and no forced None for a class. */
export function scriptGetStateName(node) {
  return node?scriptNameToString(node.record.name):'None';
}
