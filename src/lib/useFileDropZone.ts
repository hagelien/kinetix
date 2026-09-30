import { useCallback, useRef, useState } from 'react';
import type { DragEvent } from 'react';

interface FileDropProps {
  onDragEnter: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}

interface FileDropZone {
  /** Whether a file drag is currently hovering the zone (for highlight styling). */
  dragActive: boolean;
  /**
   * Spread onto the element that should accept drops. Always wired, even when
   * `enabled` is false — see the note on swallowing drops below.
   */
  dropProps: FileDropProps;
}

/**
 * Drag-and-drop file target shared by every upload affordance on the site.
 *
 * Handles the two things a hand-rolled drop zone usually gets wrong: it only
 * reacts to drags that actually carry files (so dragging selected text or a
 * link across the element doesn't light it up), and it counts dragenter /
 * dragleave pairs, because those fire for child elements too — without the
 * depth counter the highlight flickers off the moment the pointer crosses an
 * inner node.
 *
 * `onFile` receives the first dropped file, or `undefined` when the drop
 * carried none; callers do their own type/size validation.
 *
 * A disabled zone (`enabled: false` — busy, read-only, already done) still
 * cancels the browser default and shows a "no drop" cursor: unhandled, a file
 * dropped on the page navigates the tab to that file, which would tear down a
 * running upload. It just skips the highlight and never calls `onFile`.
 */
export function useFileDropZone(
  onFile: (file: File | undefined) => void,
  enabled = true,
): FileDropZone {
  // Delegates so the two hooks cannot drift: the dragenter/dragleave depth
  // counting and the swallow-when-disabled behaviour are the fiddly parts, and
  // maintaining them twice is how one of them quietly stops working.
  return useFilesDropZone((files) => onFile(files[0]), enabled);
}

/**
 * The same drop target, for a zone that accepts a whole selection at once.
 *
 * This is what the bulk PDF drop-off needs, and it is not a cosmetic variant:
 * the single-file hook takes `dataTransfer.files[0]` and silently discards the
 * rest, so dragging a folder's worth of papers onto it would upload one and
 * lose thirty-nine without saying so.
 *
 * `onFiles` receives every dropped file, in the browser's order, or an empty
 * array when the drop carried none. Callers do their own type/size validation.
 */
export function useFilesDropZone(
  onFiles: (files: File[]) => void,
  enabled = true,
): FileDropZone {
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  // Keep the latest callback without re-creating the handlers on every render.
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  const reset = useCallback(() => {
    dragDepth.current = 0;
    setDragActive(false);
  }, []);

  const dropProps: FileDropProps = {
    onDragEnter: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!enabled) return;
      dragDepth.current += 1;
      setDragActive(true);
    },
    onDragOver: (e) => {
      if (!hasFiles(e)) return;
      // Without preventDefault on dragover the browser owns the drop and
      // navigates the tab to the file instead — so cancel it either way, and
      // let the cursor say whether the zone is currently taking uploads.
      e.preventDefault();
      e.dataTransfer.dropEffect = enabled ? 'copy' : 'none';
    },
    onDragLeave: () => {
      if (!enabled) return;
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) reset();
    },
    onDrop: (e) => {
      e.preventDefault();
      reset();
      if (!enabled) return;
      onFilesRef.current(Array.from(e.dataTransfer.files ?? []));
    },
  };

  return { dragActive: enabled && dragActive, dropProps };
}

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/** MIME types a browser hands over when it has no idea what the file is. */
const OPAQUE_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/**
 * Whether a picked/dropped file is *definitively* not a PDF, so an obvious
 * mistake (a .docx, a screenshot) is reported instantly rather than after a
 * round-trip.
 *
 * Deliberately one-sided: the server verifies the magic bytes, so this only
 * has to catch what it can be certain about. Anything ambiguous passes — a
 * download saved as `paper` with no extension, or served as
 * `application/octet-stream`, is a perfectly ordinary way to end up with a
 * valid PDF on disk, and rejecting those locally would block uploads the
 * server would happily accept.
 */
export function isDefinitelyNotPdf(file: File): boolean {
  const type = file.type.toLowerCase();
  if (OPAQUE_TYPES.has(type)) {
    // No type signal: trust the extension only when it claims something else.
    const ext = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
    return ext !== undefined && ext !== '.pdf';
  }
  return type !== 'application/pdf' && type !== 'application/x-pdf';
}
