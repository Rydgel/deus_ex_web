// Firefox's memory report on request, for the Stage 7 memory tools (map-memory-census.mjs, session-hour.mjs): Gecko's memory-info
// dumper writes <tmpdir>/unified-memory-report-<id>-<pid>.json.gz, after minimizing memory (a GC and a CC) if asked to.
//
// Linux: the dumper answers real-time signals, SIGRTMIN+1 (35 with glibc) for the minimize then the report, SIGRTMIN (34) for the
// report as it is (profile-firefox-memory.mjs).
//
// macOS has no real-time signals. There the dumper watches a FIFO, debug_info_trigger, when the preference
// memory_info_dumper.watch_fifo.enabled is set at startup, and runs the same two reports for the lines "minimize memory report" and
// "memory report". The FIFO is made in memory_info_dumper.watch_fifo.directory, or in Gecko's temp directory without it; the directory
// preference has to come before the one that enables the watcher (it starts as soon as it is enabled), so each run gets a FIFO of its
// own in a fresh directory and never a stale one or another Firefox's. Checked by hand on the Mac, 2026-11-09 (Playwright's Firefox
// 1543, docs/mac-pass-2026-11-09.md): a page holding 120 MB of garbage read 128.6 MB of JS GC heap in a "memory report" and 0.2 MB in a
// "minimize memory report", and the report was <tmpdir>/unified-memory-report-<id>-<pid>.json.gz as on Linux.
import {mkdtempSync,existsSync,statSync,openSync,writeSync,closeSync,rmSync,constants} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

let fifoDir=null,launchedAt=0;

/** The Firefox preferences a run needs for requestGeckoReport, to put first in firefoxUserPrefs: none on Linux, the FIFO on macOS. */
export function geckoReportPrefs(){
  if(process.platform==='linux')return {};
  if(process.platform!=='darwin')throw new Error(`Firefox's forced memory report needs Linux (its signal) or macOS (its FIFO), not ${process.platform}`);
  fifoDir??=mkdtempSync(path.join(tmpdir(),'dx-gecko-fifo-'));launchedAt=Date.now();
  return {'memory_info_dumper.watch_fifo.directory':fifoDir,'memory_info_dumper.watch_fifo.enabled':true};
}

/** Ask the Firefox whose parent process is `pid` for its memory report, after its minimize (GC and CC) when `minimize`. */
export async function requestGeckoReport(pid,minimize){
  if(process.platform==='linux'){process.kill(pid,minimize?35:34);return;}  // SIGRTMIN+1 (glibc's SIGRTMIN is 34): minimize, then report; SIGRTMIN: the report as it is
  const fifo=path.join(fifoDir,'debug_info_trigger'),line=`${minimize?'minimize memory report':'memory report'}\n`;
  // (the FIFO this browser made: no reader yet, or not made yet, is waited for up to 30 s)
  for(let i=0;;i++){
    if(existsSync(fifo)&&statSync(fifo).isFIFO()&&statSync(fifo).mtimeMs>=launchedAt-1000){
      try{const fd=openSync(fifo,constants.O_WRONLY|constants.O_NONBLOCK);try{writeSync(fd,line);}finally{closeSync(fd);}return;}
      catch(e){if(e.code!=='ENXIO')throw e;}
    }
    if(i>=300)throw new Error(`no memory report FIFO from Firefox ${pid} in ${fifoDir}`);
    await new Promise(r=>setTimeout(r,100));
  }
}

/** The run's FIFO directory removed (macOS), once the browser is closed. */
export function forgetGeckoReportFifo(){if(fifoDir)rmSync(fifoDir,{recursive:true,force:true});fifoDir=null;}
