/**
 * Ecotopia - team member display helpers, shared by about.html and manage-team.html.
 * Kept in one file rather than copied into both pages: teamInitials is the only real
 * logic in the feature, and two copies would drift. Loadable in the browser (script
 * tag) and in Node (require) for tests, the same as assets/pricing.js.
 */
(function (root) {
  // First letter of the first word plus first letter of the last word. A single-word
  // name gives one letter. Used for the placeholder tile when a member has no photo.
  function teamInitials(name) {
    const words = String(name == null ? '' : name).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    const first = words[0][0];
    const last = words.length > 1 ? words[words.length - 1][0] : '';
    return (first + last).toUpperCase();
  }

  // 'static:<file>' is a repo asset under assets/img/team/. The charset guard means a
  // crafted value cannot escape that folder. Anything else is a gallery-bucket object,
  // resolved by the caller's publicUrl function so this file needs no Supabase client.
  function teamPhotoSrc(photoPath, publicUrl) {
    if (!photoPath) return null;
    const p = String(photoPath);
    if (p.slice(0, 7) === 'static:') {
      const file = p.slice(7);
      return /^[A-Za-z0-9._-]+$/.test(file) ? 'assets/img/team/' + file : null;
    }
    return publicUrl(p);
  }

  root.EcoTeam = { teamInitials, teamPhotoSrc };
})(typeof globalThis !== 'undefined' ? globalThis : this);
