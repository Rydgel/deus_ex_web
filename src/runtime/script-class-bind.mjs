/** Core UClass.Bind10127a20, ordinary script inheritance and already-bound
 * native classes. Native DLL-export lookup remains an explicit boundary. */
export function bindScriptClassConstructor(cls,{coreObject,isEditor,bindSuper,findRegisteredClass,isRegisteredDynamic,warn}={}) {
  if(!cls||typeof isEditor!=='function')throw new Error('UClass.Bind requires class and editor state');
  // UField.Bind10125be0 is an empty function.
  if(!isEditor()&&cls.base===null&&cls!==coreObject)
    throw new Error('Original UClass.Bind assertion: a non-Object class requires a superclass');
  if(cls.nativeConstructor===null){
    if(!Number.isInteger(cls.objectFlags))throw new Error('UClass.Bind requires native UObject flags');
    if(cls.objectFlags&0x04000000){
      // 0x10127a9f-0x10127b17: look up 'autoclass<name>' in Outer's +0x28
      // registry; the record's class pointer asserts == this and its +0x4e0
      // (ClassConstructor/InternalConstructor) is copied. Missing record:
      // appMsgf('Can't bind to native class %s') then falls through to the
      // superclass-inherit branch below.
      if(typeof findRegisteredClass==='function'){
        const ctor=findRegisteredClass(cls);
        if(ctor!==null&&ctor!==undefined){cls.nativeConstructor=ctor;}
        // A class with an autoclass record but NO distinct C++ constructor
        // (no own InternalConstructor thunk in its DLL).  The original does not
        // warn — its record exists (docs/original-startup-log.md) — and copies
        // the record's +0x4e0, which for such a class is its superclass's
        // ClassConstructor.  That is exactly what the fall-through below does
        // (Super->Bind(); this.ctor = Super.ctor), so skipping the warning here
        // and inheriting is bit-for-bit faithful, not an approximation.  See
        // docs/script-linker-preload.md for the thunk-count evidence.
        else if(typeof isRegisteredDynamic==='function'&&isRegisteredDynamic(cls)){/* record exists, no own ctor -> inherit super */}
        else if(typeof warn==='function')warn(`Can't bind to native class ${cls.name}`);
      }
    }
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
