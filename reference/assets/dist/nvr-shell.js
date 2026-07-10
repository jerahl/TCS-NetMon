// nvr-shell.jsx — DEPRECATED, kept as a thin shim.
// All sidebars/topbars now live in global-nav.jsx (loaded before this file in every HTML page).
// This shim ensures any legacy `<NVRSidebar>` / `<NVRTopbar>` references keep resolving.

if (typeof window !== "undefined") {
  if (window.GlobalSidebar) window.NVRSidebar = window.GlobalSidebar;
  if (window.GlobalTopbar) window.NVRTopbar = window.GlobalTopbar;
}