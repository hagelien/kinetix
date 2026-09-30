import Heading from '@tiptap/extension-heading';

/**
 * StarterKit's heading node, extended with a stable `sectionId` attribute
 * (#310 phase 2 / #348). Topic-page atomic facts (`wiki_fact`) anchor on
 * the heading carrying the matching `data-section-id`; the migration
 * mints these into existing docs and the editor preserves them on
 * round-trip.
 *
 * Drug monographs don't use this attribute — their sections come from a
 * fixed schema and the v2 envelope keys, so heading nodes inside a
 * monograph section's body stay vanilla.
 */
export const HeadingWithSectionId = Heading.extend({
  addAttributes() {
    return {
      ...(this.parent?.() ?? {}),
      sectionId: {
        default: null as string | null,
        parseHTML: (el): string | null => {
          const v = el.getAttribute('data-section-id');
          return v && v.length > 0 ? v : null;
        },
        renderHTML: (attrs): Record<string, string> => {
          const id = attrs.sectionId;
          if (typeof id !== 'string' || id.length === 0) return {};
          return { 'data-section-id': id };
        },
      },
    };
  },
});
