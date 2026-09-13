# Original UClass constructor binding

Authority is installed Core.dll SHA-256
`8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4`.
UClass.Bind thunk10102afe enters10127a20. It calls UField.Bind through
1010210d; that complete base body10125be0 is a return with no writes.

The remaining ordinary script-class path is:

1. Read GIsEditor101e5544. Outside the editor, assert a non-null SuperField+28
   unless the receiver is the exact Core.Object static class1029e0d0.
2. Read ClassConstructor+4e0. A non-null value skips binding and reaches the
   final assertion. No superclass virtual call occurs on this path.
3. If null, test receiver UObject.ObjectFlags+1c for RF_Native04000000.
   The native DLL-export resolution branch is a separate unsupported boundary
   in this translation; already registered native constructors bypass it.
4. For the script branch, reread ClassConstructor at10127b42. If still null,
   read SuperField; when present, call its Bind virtual at+5c, then copy its
   post-call ClassConstructor to this class (10127b5a–10127b60).
5. Reread GIsEditor. Outside the editor, assert a non-null ClassConstructor.

The helper takes explicit linked class records with mutable nativeConstructor,
objectFlags and base fields, the exact Core.Object identity, the live editor
flag getter and superclass virtual-dispatch callback. It does not infer
constructor pointers from JavaScript class names or skip the observable
superclass call. The caller must reject malformed inheritance cycles before
recursing. Native export lookup and complete PostLoad remain unsupported.

The reference case executes complete original UClass.Bind bodies for the
DataLinkPlay→ConPlayBase→Actor-shaped chain. Actor's constructor pointer is an
explicit registration input10302dab; the two script slots begin zero. The
probe verifies superclass visit order, both slot writes, and a repeated bind's
no-write path. A separate editor/null-super case establishes the final gate.
