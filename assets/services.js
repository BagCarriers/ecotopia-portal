/**
 * Ecotopia - service card photo helper, shared by the public homepage showcase
 * (assets/site.js) and the portal editor (manage-services.html).
 *
 * One copy rather than two, for the same reason as assets/team.js: the charset
 * guard is the only real logic here, and two copies of a guard drift until one
 * of them stops guarding. Loadable in the browser (script tag) and in Node
 * (require) for tests.
 */
(function (root) {
  // 'static:<file>' is a repo asset under assets/img/services/. The charset guard
  // means a crafted value cannot escape that folder. Anything else is a
  // gallery-bucket object, resolved by the caller's publicUrl function so this
  // file needs no Supabase client.
  function servicePhotoSrc(photoPath, publicUrl) {
    if (!photoPath) return null;
    const p = String(photoPath);
    if (p.slice(0, 7) === 'static:') {
      const file = p.slice(7);
      if (!/^[A-Za-z0-9._-]+$/.test(file)) return null;
      // The charset allows '.', so '.' and '..' pass the guard above. Neither
      // escapes the folder, but both name a directory rather than a file, so the
      // src would render as a broken image instead of leaving the card's own
      // bundled photo in place.
      if (/^\.+$/.test(file)) return null;
      return 'assets/img/services/' + file;
    }
    return publicUrl(p);
  }

  root.EcoServices = { servicePhotoSrc };
})(typeof globalThis !== 'undefined' ? globalThis : this);
