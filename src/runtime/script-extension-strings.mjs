import {scriptStringText} from './script-string-operations.mjs';

/** Extension execStringToName10037940. FName allocation and GError remain
 * explicit shared services; never manufacture a name-table result locally.
 * See docs/script-string-operations.md. */
export function extensionStringToName(value,{internName,logError}={}) {
  const text=scriptStringText(value);
  for(let i=0;i<text.length;i++){
    const unit=text.charCodeAt(i);
    if(unit>=0x61&&unit<=0x7a||unit>=0x41&&unit<=0x5a||unit>=0x30&&unit<=0x39||unit===0x5f||unit===0x2d)continue;
    if(typeof logError!=='function')throw new Error('StringToName invalid character requires the native GError service');
    logError({format:'StringToName: Invalid character 0x%04x in name "%s"',unit,text});
    break;
  }
  if(typeof internName!=='function')throw new Error('StringToName requires the shared native FName table');
  return internName(text,1);
}
