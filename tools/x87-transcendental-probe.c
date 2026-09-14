/* Measure the real x87 transcendental instructions that the Deus Ex Core.dll
 * thunks execute, reproducing the exact shipped sequence:
 *
 *   float32 operand -> fstp qword (widen to double) -> instruction -> fstp dword
 *
 * Core.dll thunks (GOTY, image base 0x10100000):
 *   0x10123240  fld qword [esp+4]; fsin;             ret   (native 187 Sin)
 *   0x10123250  fld qword [esp+4]; fcos;             ret   (native 188 Cos)
 *   0x10123260  fld qword [esp+4]; fptan; fstp st(0); ret   (native 189 Tan)
 *   0x10123270  fld qword [esp+4]; fld1;  fpatan;     ret   (native 190 Atan)
 *
 * WHY THIS EXISTS: the Unicorn oracle used by scripts/native-*-oracle.py runs
 * the original instruction bytes, but its softfloat implements these four
 * instructions by round-tripping through a host double — every emulated result
 * has its low 11 significand bits clear, and its NaN, infinity and
 * out-of-range edges disagree with the hardware.  Running the instruction
 * under Rosetta 2 measures the real thing instead.
 *
 * Output is CSV on stdout: function,inputBits,resultBits,significand,signExp,statusWord
 *
 * Build (macOS, after `brew install mingw-w64`):
 *   i686-w64-mingw32-gcc -O1 -o .cache/x87-transcendental-probe.exe \
 *       tools/x87-transcendental-probe.c
 * Run in the CrossOver bottle:
 *   CX_BOTTLE=DeusEx /Applications/CrossOver.app/Contents/SharedSupport/\
 *       CrossOver/bin/wine .cache/x87-transcendental-probe.exe <sweep> <maxExp>
 * <sweep> random float32 bit patterns (0 = targeted edges only); <maxExp>
 * constrains |x| < 2^maxExp (128 = the whole float32 range).
 */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static unsigned short get_cw(void){ unsigned short cw; __asm__ volatile("fnstcw %0":"=m"(cw)); return cw; }
static void set_cw(unsigned short cw){ __asm__ volatile("fldcw %0"::"m"(cw)); }

typedef struct { unsigned rbits; unsigned long long sig; unsigned short se; unsigned short sw; } res_t;

#define PROBE(NAME, INSN)                                                     \
static res_t probe_##NAME(double d){                                          \
    res_t o; float r; unsigned char raw[10]; unsigned short sw;               \
    __asm__ volatile(                                                         \
        "fldl %4\n\t" INSN "\n\t"                                             \
        "fnstsw %1\n\t"                                                       \
        "fld %%st(0)\n\t"                                                     \
        "fstpt %2\n\t"                                                        \
        "fstps %0\n\t"                                                        \
        "fninit\n\t"                                                          \
        : "=m"(r), "=m"(sw), "=m"(raw[0]), "=m"(raw[9]) : "m"(d) : "st");     \
    memcpy(&o.rbits,&r,4); memcpy(&o.sig,raw,8); memcpy(&o.se,raw+8,2);       \
    o.sw=sw; return o; }

PROBE(cos, "fcos")
PROBE(sin, "fsin")
/* the game's tan thunk: fptan then fstp st(0) discards the pushed 1.0 */
PROBE(tan, "fptan\n\tfstp %%st(0)")
/* the game's atan thunk: fld1 then fpatan == atan2(x,1) */
PROBE(atan, "fld1\n\tfpatan")

static unsigned fb(float f){ unsigned u; memcpy(&u,&f,4); return u; }
static float bf(unsigned u){ float f; memcpy(&f,&u,4); return f; }

static void emit(const char*fn,unsigned in,res_t o){
    printf("%s,%08x,%08x,%016llx,%04x,%04x\n",fn,in,o.rbits,
           (unsigned long long)o.sig,o.se,o.sw);
}
static void one(const char*fn,unsigned in){
    double d=(double)bf(in); res_t o;
    if(!strcmp(fn,"cos")) o=probe_cos(d);
    else if(!strcmp(fn,"sin")) o=probe_sin(d);
    else if(!strcmp(fn,"tan")) o=probe_tan(d);
    else o=probe_atan(d);
    emit(fn,in,o);
}
static unsigned long long st=0x9e3779b97f4a7c15ULL;
static unsigned nxt(void){ st^=st<<13; st^=st>>7; st^=st<<17; return (unsigned)(st>>32); }

int main(int argc,char**argv){
    int sweep = argc>1 ? atoi(argv[1]) : 0;
    unsigned short cw0=get_cw();
    fprintf(stderr,"CRT default control word = 0x%04x (PC=%d)\n",cw0,(cw0>>8)&3);
    printf("# default_cw=%04x\n",cw0);
    const char*fns[4]={"cos","sin","tan","atan"};
    /* targeted edges: zeros, +-1, pi/2, the 2^63 boundary, infinities, NaNs */
    unsigned edges[]={0x00000000,0x80000000,0x3f800000,0xbf800000,0x3fc90fdb,
        0x40490fdb,0x5effffff,0x5f000000,0x5f000001,0x7f7fffff,0xff7fffff,
        0x7f800000,0xff800000,0x7fc00000,0xffc00000,0x7fc00001,0xffc00001,
        0x7f800001,0xff800001,0x00000001,0x00800000};
    for(int f=0;f<4;f++)
        for(unsigned i=0;i<sizeof(edges)/sizeof(*edges);i++){ set_cw(cw0); one(fns[f],edges[i]); }
    int emax = argc>2 ? atoi(argv[2]) : 128;   /* constrain |x| < 2^emax */
    for(int i=0;i<sweep;i++){
        unsigned b=nxt();
        if(emax<128){ unsigned e=(b>>23)&0xff; e = e % (unsigned)(127+emax+1); b=(b&0x807fffff)|(e<<23); }
        for(int f=0;f<4;f++){ set_cw(cw0); one(fns[f],b); } }
    return 0;
}
