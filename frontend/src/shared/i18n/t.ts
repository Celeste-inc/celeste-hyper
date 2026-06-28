// i18n seam (CC.4). Every user-facing string flows through t() so that swapping in i18next later is a
// one-file change here, not a sweep through every component. Today it is the identity function
// (English-only), and i18next's t() with natural-language keys is a drop-in replacement: it returns
// the key itself as the fallback when no translation exists, so wrapped call sites keep working.
export function t(key: string): string {
  return key;
}
