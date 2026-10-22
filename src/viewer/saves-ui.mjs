/** The Saves window of the page (docs/save-storage.md "The folder flow"): the controls for where the player's saves are kept, outside the original's UI
 * like the gate. `persistence()` is the page's save persistence (save-persistence.mjs), or null while it opens; `toast` says what happened. */

/** The status line and note for a persistence status (pure: the unit test reads them). */
export function describeSaves(status) {
  if (!status) return { line: 'Saves are being opened…', note: null };
  const count = n => `${n} save${n === 1 ? '' : 's'}`;
  let line;
  if (status.mode === 'off') line = 'Saves are not kept or listed on this page (it was opened with saves off).';
  else if (status.source === 'folder') {
    line = status.folder?.installed ? `Saves are in the Save folder of “${status.folder.name}” (${count(status.slots)}).`
      : `Saves are in the folder “${status.folder?.name}” (${count(status.slots)}).`;
  } else if (status.source === 'browser') line = `Saves are kept in this browser (${count(status.slots)}).`;
  else line = `Saves last only until this page closes (${count(status.slots)}).`;
  if (status.served) line += ' The installed game\'s Save folder is also listed, read-only.';
  const note = status.error?.message ?? status.message ?? null;
  return { line, note };
}

export function createSavesUi({ $, toast, persistence, download = downloadBlob }) {
  const dialog = $('saves-dialog');
  const guarded = work => async () => {
    try { return await work(); }
    catch (error) { if (error?.kind !== 'cancelled') toast(error?.message ?? String(error), 9000); update(); }
  };
  function update() {
    const status = persistence()?.status() ?? null;
    const { line, note } = describeSaves(status);
    $('saves-status').textContent = line;
    $('saves-note').hidden = !note; $('saves-note').textContent = note ?? '';
    const folder = status?.folder ?? null;
    $('saves-folder').hidden = !status?.canPickFolder;
    $('saves-folder').textContent = status?.source === 'folder' ? 'Use another folder…' : 'Use a Save folder…';
    $('saves-reconnect').hidden = !(folder && folder.state === 'prompt');
    $('saves-forget').hidden = !folder;
    $('saves-import').disabled = !status || status.mode === 'off';
    $('saves-export').disabled = !status || status.mode === 'off' || status.slots === 0;
  }
  function open() { document.exitPointerLock?.(); if (!dialog.open) dialog.showModal(); update(); }
  function bind() {
    $('saves-open').onclick = () => { document.getElementById('tools-menu')?.hidePopover?.(); open(); };
    $('gate-saves').onclick = open;
    $('saves-folder').onclick = guarded(async () => {
      await persistence().pickFolder();
      toast(describeSaves(persistence().status()).line, 6000);
    });
    $('saves-reconnect').onclick = guarded(async () => { await persistence().reconnectFolder(); toast(describeSaves(persistence().status()).line, 6000); });
    $('saves-forget').onclick = guarded(async () => { await persistence().forgetFolder(); toast(describeSaves(persistence().status()).line, 6000); });
    $('saves-import').onclick = () => $('saves-input').click();
    $('saves-input').onchange = guarded(async () => {
      const files = Array.from($('saves-input').files ?? []);
      $('saves-input').value = '';
      if (!files.length) return;
      const { written, skipped } = await persistence().importFiles(files);
      toast(written ? `Imported ${written} file${written === 1 ? '' : 's'}${skipped.length ? ` (${skipped.length} not part of a save, left out)` : ''}.`
        : 'No saves in that folder: choose the Save folder of the game, or one of its SaveNNNN folders.', 8000);
      update();
    });
    $('saves-export').onclick = guarded(async () => {
      const { name, bytes, count } = await persistence().exportZip();
      if (!count) { toast('There are no saves to export.'); return; }
      download(name, bytes);
      toast(`Exported ${count} file${count === 1 ? '' : 's'}: unpack ${name} so that its Save folder replaces or joins the game's.`, 9000);
    });
  }
  return { open, update, bind, dialog };
}

/** Offer bytes as a file download (a Blob and a link click). */
export function downloadBlob(name, bytes, type = 'application/zip') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.hidden = true;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
