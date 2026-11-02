/**
 * Pure cursor state machine for the story and view-once pix viewer.
 */

export interface ViewerCursor {
  readonly groupIdx: number;
  readonly storyIdx: number;
}

export type ViewerStep =
  | { readonly kind: 'stay' }
  | { readonly kind: 'step'; readonly cursor: ViewerCursor }
  | { readonly kind: 'turnCube'; readonly cursor: ViewerCursor; readonly direction: 1 | -1 }
  | { readonly kind: 'close' };

/**
 * Compute the next transition for an `'advance'` or `'rewind'` action given the number of items
 * in each group. When `lockRewind` is true (view-once pix), backward navigation is a no-op.
 */
export function stepViewer(
  cursor: ViewerCursor,
  groupLengths: readonly number[],
  action: 'advance' | 'rewind',
  lockRewind = false,
): ViewerStep {
  const currentGroupLen = groupLengths[cursor.groupIdx] ?? 0;
  if (currentGroupLen === 0 || cursor.storyIdx >= currentGroupLen) {
    return { kind: 'close' };
  }

  if (action === 'advance') {
    if (cursor.storyIdx < currentGroupLen - 1) {
      return { kind: 'step', cursor: { groupIdx: cursor.groupIdx, storyIdx: cursor.storyIdx + 1 } };
    }
    if (cursor.groupIdx < groupLengths.length - 1 && (groupLengths[cursor.groupIdx + 1] ?? 0) > 0) {
      return {
        kind: 'turnCube',
        cursor: { groupIdx: cursor.groupIdx + 1, storyIdx: 0 },
        direction: 1,
      };
    }
    return { kind: 'close' };
  }

  if (lockRewind) {
    return { kind: 'stay' };
  }
  if (cursor.storyIdx > 0) {
    return { kind: 'step', cursor: { groupIdx: cursor.groupIdx, storyIdx: cursor.storyIdx - 1 } };
  }
  if (cursor.groupIdx > 0 && (groupLengths[cursor.groupIdx - 1] ?? 0) > 0) {
    return {
      kind: 'turnCube',
      cursor: { groupIdx: cursor.groupIdx - 1, storyIdx: 0 },
      direction: -1,
    };
  }
  return { kind: 'stay' };
}
