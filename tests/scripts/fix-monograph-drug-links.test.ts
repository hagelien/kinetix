import { describe, expect, it } from 'vitest';

// Importing the script must not hit the database — `main()` only runs behind
// the `isDirectRun` guard at the bottom of the file, so evaluating its module
// scope (including this import) never opens a connection or reads
// DATABASE_URL.
import { isEmptyDuplicateSafeToDelete } from '../../scripts/fix-monograph-drug-links';

describe('isEmptyDuplicateSafeToDelete', () => {
  it('is safe for a page with no revisions and no pending edits', () => {
    expect(isEmptyDuplicateSafeToDelete(0, 0)).toBe(true);
  });

  it('is safe for a page with only its ensureDrugMonograph creation revision', () => {
    expect(isEmptyDuplicateSafeToDelete(1, 0)).toBe(true);
  });

  it('is NOT safe when the page has been edited after creation, even if empty now', () => {
    // Someone edited the page and cleared it back to empty — wiki_revisions
    // cascades on delete, so that history would be destroyed.
    expect(isEmptyDuplicateSafeToDelete(2, 0)).toBe(false);
  });

  it('is NOT safe when a wiki_page/wiki_section/wiki_fact pending edit targets the page', () => {
    // Deleting the page leaves the polymorphic pending_edits.target_id
    // pointing at nothing.
    expect(isEmptyDuplicateSafeToDelete(1, 1)).toBe(false);
    expect(isEmptyDuplicateSafeToDelete(0, 1)).toBe(false);
  });

  it('is NOT safe when both signals are present', () => {
    expect(isEmptyDuplicateSafeToDelete(3, 2)).toBe(false);
  });
});
