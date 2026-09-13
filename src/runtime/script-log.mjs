import {refValue} from './script-vm.mjs';
import {scriptNameToString, scriptStringText} from './script-string-operations.mjs';

/**
 * Core UObject::execLog (native 231) contract recovered from the installed
 * GOTY Core.u/Core.dll pair.  The browser has no FOutputDevice/GLog object, so
 * the final Logf call remains an explicit synchronous host boundary.
 */
export const OBJECT_LOG_CONTRACT = Object.freeze({
  package: 'Core',
  function: 'Object.Log',
  exportIndex: 585,
  nativeIndex: 231,
  scriptSize: 10,
  thunkAddress: 0x101031cf,
  bodyAddress: 0x1013cae0,
  logfAddress: 0x10145380,
  gLogAddress: 0x101a7c34,
  formatAddress: 0x101aafd0,
  emptyStringAddress: 0x101ef654,
  defaultTagIndex: 0x302,
  defaultTag: 'ScriptLog',
  expressionTable: 0x101f41b8,
  stringOpcode: 0x1f,
  nameOpcode: 0x21,
  endFunctionParmsOpcode: 0x16,
  coreDllSha256: '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
});

function requireLogDevice(logDevice) {
  if (typeof logDevice === 'function') return logDevice;
  if (typeof logDevice?.log === 'function') return event => logDevice.log(event);
  throw new Error('Object.Log requires the original synchronous GLog output device');
}

function evaluateArgument(call, index) {
  if (typeof call.evaluateArgument !== 'function') {
    throw new Error(`Object.Log cannot evaluate argument ${index} without the linked FFrame`);
  }
  return refValue(call.evaluateArgument(index));
}

/**
 * Execute Object.Log's logical adapter.  `logDevice` receives
 * `{text, tag, tagIndex}` after both native arguments have been evaluated.
 * The default tag retains the original EName category (0x302/ScriptLog);
 * supplied names retain their canonical spelling and have no fabricated table
 * index in the logical runtime.  A host callback must be synchronous because
 * the original FOutputDevice::Logf call cannot suspend.
 */
export function execObjectLog(call, {logDevice} = {}) {
  const argumentCount = call?.argumentCount;
  if (argumentCount !== 1 && argumentCount !== 2) {
    throw new Error('Object.Log requires a string and an optional name tag');
  }

  // P_GET_STR then P_GET_NAME_OPTX are separate Stack.Step calls.  Keep the
  // evaluations in that order and do not inspect the output device until both
  // expression results have been copied out of their FFrame temporaries.
  const text = scriptStringText(evaluateArgument(call, 0));
  const suppliedTag = argumentCount === 2 ? evaluateArgument(call, 1) : undefined;
  const tag = suppliedTag === undefined
    ? OBJECT_LOG_CONTRACT.defaultTag
    : scriptNameToString(suppliedTag);
  const tagIndex = suppliedTag === undefined ? OBJECT_LOG_CONTRACT.defaultTagIndex : null;
  const event = Object.freeze({text, tag, tagIndex});
  const log = requireLogDevice(logDevice);
  const result = log(event);
  if (result && typeof result.then === 'function') {
    throw new Error('Object.Log requires a synchronous GLog output device');
  }
  // The native is void; the host result is deliberately not exposed to script.
}
