/**
 * Ecotopia Portal - Nav
 * Injects sidebar (desktop) + bottom nav (mobile) into protected pages.
 */
const Nav = (() => {
  const links = [
    { href: 'dashboard.html',  label: 'Dashboard',   icon: '⌂'  },
    { href: 'jobs.html',       label: 'Jobs',        icon: '🔨' },
    { href: 'orders.html',     label: 'Orders',      icon: '📦' },
    { href: 'gardens.html',    label: 'Gardens',     icon: '🌿' },
    { href: 'clients.html',    label: 'Clients',     icon: '👤' },
    { href: 'volunteers.html', label: 'Volunteers',  icon: '🤝' },
    { href: 'events.html',     label: 'Events',      icon: '📅' },
    { href: 'gallery.html',    label: 'Gallery',     icon: '📷' },
    { href: 'manage-services.html', label: 'Services', icon: '🛠' },
    { href: 'manage-plants.html', label: 'Plants', icon: '🌼' },
    { href: 'manage-shop.html', label: 'Shop', icon: '🛍' },
    { href: 'manage-team.html', label: 'Team', icon: '🧑‍🌾' },
    { href: 'calendar.html',   label: 'Calendar',    icon: '🗓'  },
    { href: 'invoices.html',   label: 'Invoices',    icon: '💵' },
    { href: 'quotes.html',     label: 'Quotes',      icon: '📄' },
    { href: 'grants.html',     label: 'Grants',      icon: '🏛'  },
    { href: 'grant-finder.html', label: 'Grant Finder', icon: '🔎' },
    { href: 'question-inbox.html', label: 'Questions', icon: '❓' },
    { href: 'review-inbox.html', label: 'Reviews', icon: '⭐' },
    { href: 'reports.html',    label: 'Reports',     icon: '📊' },
  ];

  // Primary bottom-nav items (mobile)
  const primaryLinks = [
    { href: 'dashboard.html',  label: 'Home',      icon: '⌂'  },
    { href: 'jobs.html',       label: 'Jobs',      icon: '🔨' },
    { href: 'gardens.html',    label: 'Gardens',   icon: '🌿' },
    { href: 'volunteers.html', label: 'Volunteers',icon: '🤝' },
  ];

  function currentPage() {
    return window.location.pathname.split('/').pop() || 'index.html';
  }

  function isActive(href) {
    return currentPage() === href;
  }

  function render() {
    const page = currentPage();

    // ── Shared CSS injected once ────────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
      /* Nav resets + layout */
      body { display: flex; min-height: 100vh; }

      /* Sidebar */
      #eco-sidebar {
        position: fixed; top: 0; left: 0; bottom: 0;
        width: 220px; background: var(--forest); color: #fff;
        display: flex; flex-direction: column;
        z-index: 100; overflow-y: auto;
        font-family: 'DM Sans', sans-serif;
      }
      #eco-sidebar .sidebar-logo {
        display: block; color: inherit; text-decoration: none;
        padding: 24px 20px 16px;
        font-family: 'Fraunces', serif;
        font-size: 1.3rem; font-weight: 700;
        color: var(--sage); border-bottom: 1px solid rgba(255,255,255,0.1);
        letter-spacing: -0.01em;
      }
      #eco-sidebar nav { flex: 1; padding: 12px 0; }
      #eco-sidebar nav a {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 20px; color: rgba(255,255,255,0.8);
        text-decoration: none; font-size: 0.9rem;
        transition: background 0.15s, color 0.15s;
        border-radius: 0;
      }
      #eco-sidebar nav a:hover,
      #eco-sidebar nav a.active {
        background: var(--forest-mid); color: #fff;
      }
      #eco-sidebar nav a.active {
        border-left: 3px solid var(--forest-light);
        padding-left: 17px;
      }
      #eco-sidebar nav a .nav-icon { font-size: 1.1rem; width: 22px; text-align:center; }
      #eco-sidebar .sidebar-footer {
        padding: 16px 20px;
        border-top: 1px solid rgba(255,255,255,0.1);
      }
      #eco-sidebar .sidebar-footer button {
        background: none; border: 1px solid rgba(255,255,255,0.3);
        color: rgba(255,255,255,0.7); padding: 8px 14px; border-radius: 6px;
        cursor: pointer; font-size: 0.85rem; width: 100%;
        font-family: 'DM Sans', sans-serif;
        transition: background 0.15s;
      }
      #eco-sidebar .sidebar-footer button:hover {
        background: rgba(255,255,255,0.1); color:#fff;
      }

      /* Main content offset. Column flex so the attribution footer, which this
         wrapper swallows along with the page content, can be pushed to the bottom
         by its own margin-top:auto. Without it a short page (an empty Gallery, say)
         leaves the footer floating mid-screen with cream below it. */
      #eco-main {
        margin-left: 220px; flex: 1; min-width: 0;
        display: flex; flex-direction: column; min-height: 100vh;
      }
      /* The page body grows; the footer keeps its own height. */
      #eco-main > .bc-thinfoot { flex: 0 0 auto; margin-top: auto; }

      /* Mobile bottom nav */
      #eco-bottomnav {
        display: none;
        position: fixed; bottom: 0; left: 0; right: 0;
        background: var(--forest); z-index: 200;
        height: 64px;
        box-shadow: 0 -2px 12px rgba(0,0,0,0.18);
      }
      /* flex:1 is load-bearing. The bar itself is display:flex on mobile, so without
         it this single child shrinks to its content width and packs against the left
         edge, running the five labels together as "HomeJobsGardensVolunteersMore". */
      #eco-bottomnav .bn-items {
        display: flex; height: 100%; flex: 1; min-width: 0;
      }
      #eco-bottomnav .bn-item {
        flex: 1; display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        color: rgba(255,255,255,0.65); text-decoration: none;
        font-size: 0.68rem; gap: 2px; cursor: pointer;
        font-family: 'DM Sans', sans-serif;
        transition: color 0.15s;
        border: none; background: none;
        /* Equal shares that can actually shrink: min-width:0 lets a long label like
           Volunteers narrow instead of forcing the row wider than the screen. */
        min-width: 0; padding: 0 2px; text-align: center; line-height: 1.1;
      }
      #eco-bottomnav .bn-item .bn-icon { font-size: 1.3rem; line-height:1; }
      #eco-bottomnav .bn-item.active,
      #eco-bottomnav .bn-item:hover { color: var(--forest-light); }

      /* More drawer */
      #eco-more-drawer {
        display: none; position: fixed; bottom: 64px; left: 0; right: 0;
        background: var(--forest); z-index: 199;
        padding: 8px 0; border-top: 1px solid rgba(255,255,255,0.1);
        box-shadow: 0 -4px 20px rgba(0,0,0,0.25);
        /* Sixteen links do not fit above the 64px bar on a phone. Without a cap the
           drawer grows off the top of the screen and those entries cannot be reached
           at all, because a fixed element has nothing to scroll. Cap it and let the
           drawer itself scroll. dvh tracks Safari's collapsing URL bar; the vh line
           above it is the fallback for browsers that lack dvh. */
        max-height: calc(100vh - 64px - 12px);
        max-height: calc(100dvh - 64px - 12px);
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        /* Do not chain the scroll to the page behind once the list hits its end. */
        overscroll-behavior: contain;
      }
      #eco-more-drawer.open { display: block; }
      #eco-more-drawer a {
        display: flex; align-items: center; gap: 12px;
        padding: 12px 24px; color: rgba(255,255,255,0.85);
        text-decoration: none; font-size: 0.9rem;
        font-family: 'DM Sans', sans-serif;
      }
      #eco-more-drawer a:hover,
      #eco-more-drawer a.active { color: var(--forest-light); }
      #eco-more-drawer a .nav-icon { font-size: 1.1rem; width:22px; text-align:center; }

      @media (max-width: 768px) {
        #eco-sidebar { display: none; }
        #eco-main { margin-left: 0; padding-bottom: 80px; }
        #eco-bottomnav { display: flex; }
      }
    `;
    document.head.appendChild(style);

    // ── Sidebar ─────────────────────────────────────────────────────────────
    const sidebar = document.createElement('div');
    sidebar.id = 'eco-sidebar';
    sidebar.innerHTML = `
      <a class="sidebar-logo" href="index.html" title="View the public website">🌿 Ecotopia</a>
      <nav>
        ${links.map(l => `
          <a href="${l.href}" class="${isActive(l.href) ? 'active' : ''}">
            <span class="nav-icon">${l.icon}</span>${l.label}
          </a>`).join('')}
      </nav>
      <div class="sidebar-footer">
        <button id="eco-signout-btn" onclick="AuthManager.signOut()">Sign out</button>
      </div>
    `;
    document.body.insertBefore(sidebar, document.body.firstChild);

    // ── Wrap existing body content ───────────────────────────────────────────
    const main = document.createElement('div');
    main.id = 'eco-main';
    // Move all non-sidebar children into main
    const children = Array.from(document.body.children).filter(el => el !== sidebar);
    children.forEach(c => main.appendChild(c));
    document.body.appendChild(main);

    // ── Bottom nav ───────────────────────────────────────────────────────────
    const moreLinks = links.filter(l => !primaryLinks.find(p => p.href === l.href));

    const bottomnav = document.createElement('div');
    bottomnav.id = 'eco-bottomnav';

    const moreDrawer = document.createElement('div');
    moreDrawer.id = 'eco-more-drawer';
    moreDrawer.innerHTML = moreLinks.map(l => `
      <a href="${l.href}" class="${isActive(l.href) ? 'active' : ''}">
        <span class="nav-icon">${l.icon}</span>${l.label}
      </a>`).join('');

    bottomnav.innerHTML = `
      <div class="bn-items">
        ${primaryLinks.map(l => `
          <a href="${l.href}" class="bn-item ${isActive(l.href) ? 'active' : ''}">
            <span class="bn-icon">${l.icon}</span>${l.label}
          </a>`).join('')}
        <button class="bn-item" id="bn-more-btn">
          <span class="bn-icon">☰</span>More
        </button>
      </div>
    `;

    document.body.appendChild(moreDrawer);
    document.body.appendChild(bottomnav);

    document.getElementById('bn-more-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      moreDrawer.classList.toggle('open');
    });
    document.addEventListener('click', () => moreDrawer.classList.remove('open'));

    // ── Personalize sign-out label with the signed-in user (async) ───────────
    if (typeof AuthManager !== 'undefined' && AuthManager.getUser) {
      AuthManager.getUser().then((email) => {
        if (!email) return;
        const btn = document.getElementById('eco-signout-btn');
        if (btn) btn.textContent = 'Sign out (' + email.split('@')[0] + ')';
      }).catch(() => {});
    }

    // ── Admin-only Users link (async: role fetch) ────────────────────────────
    if (typeof AuthManager !== 'undefined' && AuthManager.getRole) {
      AuthManager.getRole().then((role) => {
        if (role !== 'admin') return;
        const activeCls = isActive('users.html') ? 'active' : '';
        // Desktop sidebar (appended after the last nav link, before the footer)
        const nav = document.querySelector('#eco-sidebar nav');
        if (nav) {
          const a = document.createElement('a');
          a.href = 'users.html';
          a.className = activeCls;
          a.innerHTML = '<span class="nav-icon">🔑</span>Users';
          nav.appendChild(a);
        }
        // Mobile "More" drawer
        const drawer = document.getElementById('eco-more-drawer');
        if (drawer) {
          const m = document.createElement('a');
          m.href = 'users.html';
          m.className = activeCls;
          m.innerHTML = '<span class="nav-icon">🔑</span>Users';
          drawer.appendChild(m);
        }
      }).catch(() => { /* role fetch failed: omit the admin link, fail closed */ });
    }
  }

  return { render };
})();
