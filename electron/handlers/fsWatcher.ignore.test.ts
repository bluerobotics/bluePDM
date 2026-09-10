import { describe, expect, it } from 'vitest'

import { isIgnoredVaultPath } from './fsWatcher'

/**
 * The watcher and the full vault scan share this predicate. When they disagreed,
 * SolidWorks lock files were recorded by the scan but never watched, so they
 * surfaced as local-only files that appeared and vanished as documents were
 * opened and closed. One production vault logged 83 unmatched local files while
 * SolidWorks held documents open, and none of them a minute later.
 */
describe('isIgnoredVaultPath', () => {
  it('ignores SolidWorks lock files wherever they sit', () => {
    expect(isIgnoredVaultPath('~$bracket.sldprt')).toBe(true)
    expect(isIgnoredVaultPath('br equipment/big-boi/~$2336a113_locating pin.sldprt')).toBe(true)
  })

  it('ignores the editor and shell droppings the watcher already skipped', () => {
    expect(isIgnoredVaultPath('desktop.ini')).toBe(true)
    expect(isIgnoredVaultPath('WLP/Thumbs.db')).toBe(true)
    expect(isIgnoredVaultPath('notes.swp')).toBe(true)
    expect(isIgnoredVaultPath('part.sldprt.download')).toBe(true)
    expect(isIgnoredVaultPath('assembly.tmp')).toBe(true)
  })

  it('ignores dotfiles, which is what the scan filtered on before', () => {
    expect(isIgnoredVaultPath('.git')).toBe(true)
    expect(isIgnoredVaultPath('WLP/.hidden')).toBe(true)
  })

  it('keeps real vault files, including names that merely contain the marker characters', () => {
    expect(isIgnoredVaultPath('WLP/DEVELOPMENT/SS316/WLP-M14-BULKHEAD-10.5MM-SS316.SLDDRW')).toBe(
      false,
    )
    expect(isIgnoredVaultPath('parts/bracket~1.sldprt')).toBe(false)
    expect(isIgnoredVaultPath('parts/cost$estimate.sldprt')).toBe(false)
    expect(isIgnoredVaultPath('parts/temporary-fixture.sldprt')).toBe(false)
  })
})
