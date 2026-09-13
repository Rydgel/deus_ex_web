/* Read-only targeted Stage 3 capture. Build output belongs in .cache.
 * Args: current GObjObjects slots for Class.Conversation and the mission list.
 * Slot identities are checked before any layout interpretation.
 * Reuses the existing Windows process/module discovery helpers. */
#define main unused_registry_main
#include "dump-gobjects-win.c"
#undef main
#include <stdlib.h>

static HANDLE capture_process;
static unsigned capture_names, capture_name_count;
static void exact(unsigned address, void *out, unsigned size) {
  if (!read_mem(capture_process, address, out, size)) {
    fprintf(stderr, "ReadProcessMemory failed address=%08x size=%u error=%lu\n",
      address, size, GetLastError()); exit(2);
  }
}
static unsigned word(unsigned address) { unsigned v; exact(address, &v, 4); return v; }
static void name_text(unsigned index, char *out) {
  if (index >= capture_name_count) { fprintf(stderr,"Invalid name index %u\n",index); exit(2); }
  unsigned ptr=word(capture_names+4*index);
  if (!ptr) { fprintf(stderr,"Null name entry %u\n",index); exit(2); }
  unsigned i;
  for(i=0;i<127;i++) {
    unsigned short ch; exact(ptr+12+2*i,&ch,2);
    if (!ch) break;
    out[i]=ch<128?(char)ch:'?';
  }
  out[i]=0;
}
static void object_name(unsigned object, char *out) { name_text(word(object+0x20),out); }
int main(int argc,char **argv) {
  if(argc!=3) { fprintf(stderr,"Usage: dump-stage3-win.exe CONVERSATION_CLASS_SLOT MISSION_LIST_SLOT\n"); return 1; }
  DWORD pid=find_pid("DeusEx.exe");
  if(!pid) { fprintf(stderr,"DeusEx.exe not running\n"); return 1; }
  capture_process=OpenProcess(PROCESS_QUERY_INFORMATION|PROCESS_VM_READ,FALSE,pid);
  if(!capture_process) { fprintf(stderr,"OpenProcess failed %lu\n",GetLastError()); return 1; }
  unsigned core=(unsigned)module_base(pid,"Core.dll",capture_process);
  if(!core) { fprintf(stderr,"Core.dll not loaded\n"); return 1; }
  unsigned objects=word(core+0x19e628),count=word(core+0x19e62c);
  capture_names=word(core+0x1961f0);capture_name_count=word(core+0x1961f4);
  unsigned class_slot=strtoul(argv[1],NULL,10),list_slot=strtoul(argv[2],NULL,10);
  if(class_slot>=count||list_slot>=count) { fprintf(stderr,"Slot out of range\n"); return 2; }
  unsigned cls=word(objects+class_slot*4),list=word(objects+list_slot*4);
  char cn[128],ct[128],co[128],ln[128],lt[128];
  object_name(cls,cn);object_name(word(cls+0x24),ct);object_name(word(cls+0x18),co);
  object_name(list,ln);object_name(word(list+0x24),lt);
  if(strcmp(cn,"Conversation")||strcmp(ct,"Class")||strcmp(co,"ConSys")||
     strcmp(ln,"ConList_Mission00")||strcmp(lt,"ConversationList")) {
    fprintf(stderr,"Unexpected live slot identities %s.%s %s.%s\n",ct,cn,lt,ln);return 2;
  }
  printf("capture pid=%lu core=%08x objects=%u names=%u\n",pid,core,count,capture_name_count);
  printf("class slot=%u ptr=%08x outer=%s name=%s propertiesSize=%u\n",
    class_slot,cls,co,cn,word(cls+0x3c));
  unsigned child=word(cls+0x38),guard=0;
  while(child) {
    if(++guard>1024) { fprintf(stderr,"Children chain exceeded bound\n");return 2; }
    char name[128],type[128];object_name(child,name);object_name(word(child+0x24),type);
    if(strstr(type,"Property")) {
      if(word(child+0x18)!=cls) { fprintf(stderr,"Unexpected property Outer\n");return 2; }
      printf("property name=%s type=%s offset=%u size=%u dim=%u flags=%08x",
        name,type,word(child+0x48),word(child+0x38),word(child+0x34),word(child+0x3c));
      if(!strcmp(type,"BoolProperty"))printf(" mask=%08x",word(child+0x5c));
      printf("\n");
    }
    child=word(child+0x2c);
  }
  unsigned loader_data=word(core+0x19e608),loader_count=word(core+0x19e60c);
  printf("loadState nest=%u loadedNum=%u loaderNum=%u\n",
    word(core+0x1a2650),word(core+0x19e63c),loader_count);
  if(loader_count>4096) { fprintf(stderr,"Unexpected loader count\n");return 2; }
  unsigned list_name=word(list+0x20);
  printf("mission slot=%u ptr=%08x nameIndex=%u flags=%08x linker=%08x linkerIndex=%u\n",
    list_slot,list,list_name,word(list+0x1c),word(list+0x10),word(list+0x14));
  for(unsigned i=0;i<loader_count;i++) {
    unsigned linker=word(loader_data+4*i),root=word(linker+0x28);
    char name[128];object_name(root,name);
    if(strcmp(name,"DeusExConText"))continue;
    unsigned export_data=word(linker+0x84),export_count=word(linker+0x88);
    printf("linker ordinal=%u ptr=%08x package=%s root=%08x exports=%u\n",i,linker,name,root,export_count);
    if(export_count>1000000) { fprintf(stderr,"Unexpected export count\n");return 2; }
    unsigned *entries=malloc(export_count*0x24);
    if(!entries) return 2;
    exact(export_data,entries,export_count*0x24);
    for(unsigned j=0;j<export_count;j++)if(entries[j*9+3]==list_name) {
      printf("missionExport index=%u words=",j);
      for(unsigned k=0;k<9;k++)printf("%s%08x",k?",":"",entries[j*9+k]);
      printf(" sameObject=%u\n",entries[j*9+7]==list);
    }
    free(entries);
  }
  CloseHandle(capture_process);return 0;
}
