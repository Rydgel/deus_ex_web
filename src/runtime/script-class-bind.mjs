/** Core UClass.Bind10127a20, ordinary script inheritance and already-bound
 * native classes. Native DLL-export lookup remains an explicit boundary. */
export function bindScriptClassConstructor(cls,{coreObject,isEditor,bindSuper}={}) {
  if(!cls||typeof isEditor!=='function')throw new Error('UClass.Bind requires class and editor state');
  // UField.Bind10125be0 is an empty function.
  if(!isEditor()&&cls.base===null&&cls!==coreObject)
    throw new Error('Original UClass.Bind assertion: a non-Object class requires a superclass');
  if(cls.nativeConstructor===null){
    if(!Number.isInteger(cls.objectFlags))throw new Error('UClass.Bind requires native UObject flags');
    if(cls.objectFlags&0x04000000)
      throw new Error('UClass.Bind native DLL-export resolution is unsupported');
    if(cls.nativeConstructor===null&&cls.base!==null){
      if(typeof bindSuper!=='function')throw new Error('UClass.Bind requires superclass virtual dispatch');
      bindSuper(cls.base);
      cls.nativeConstructor=cls.base.nativeConstructor;
    }
  }
  if(!isEditor()&&cls.nativeConstructor===null)
    throw new Error('Original UClass.Bind assertion: ClassConstructor is null');
  if(cls.nativeConstructor!==null&&(!Number.isInteger(cls.nativeConstructor)||cls.nativeConstructor<=0))
    throw new Error('UClass.Bind requires a resolved native constructor pointer');
}
