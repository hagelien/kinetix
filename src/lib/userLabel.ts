/**
 * Pick the user-facing label for a user reference. Display name wins if set;
 * the username (the login handle) is the fallback.
 */
export interface UserLabelInput {
  username?: string | null;
  displayName?: string | null;
}

export function userLabel(user: UserLabelInput | null | undefined): string {
  if (!user) return 'Unknown';
  const trimmed = user.displayName?.trim();
  if (trimmed) return trimmed;
  return user.username ?? 'Unknown';
}
