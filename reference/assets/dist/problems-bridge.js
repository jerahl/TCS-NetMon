// problems-bridge.jsx
//
// Adapts the ActionProblems / ActionProblemsData JSON payload into window
// globals consumed by problems-app.jsx. Exposes an imperative API the app
// uses every time the filter panel changes:
//
//   window.tcsProblemsFetch(filterDelta)  — merge into current filters + refetch
//   window.tcsProblemsRefresh()           — refetch with the current filters
//
// Dispatches "tcs:problems-data" with the parsed payload on every success.

(function () {
  const EMPTY = {
    problems: [],
    metrics: {
      total: 0,
      bySeverity: {
        disaster: 0,
        high: 0,
        warning: 0,
        info: 0
      },
      unacked: 0,
      avgAgeSec: 0,
      avgAgeStr: "—",
      topHosts: [],
      topGroups: []
    },
    groups: [],
    filters: {
      severity: "",
      ack: "any",
      groupids: "",
      search: "",
      maxAge: "all"
    },
    ts: 0
  };
  const apply = b => {
    const merged = {
      ...EMPTY,
      ...(b || {})
    };
    merged.metrics = {
      ...EMPTY.metrics,
      ...(merged.metrics || {})
    };
    window.PROBLEMS_DATA = merged;
  };
  apply(window.PROBLEMS_BOOT);
  let currentFilters = {
    ...window.PROBLEMS_DATA.filters
  };
  const base = window.TCS_PROBLEMS_DATA_URL;
  const REFRESH_MS = 30_000;
  const fetchNow = async () => {
    if (!base) return;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(currentFilters)) {
      if (v !== "" && v != null) qs.set(k, v);
    }
    const url = qs.toString() ? `${base}&${qs}` : base;
    try {
      const resp = await fetch(url, {
        credentials: "same-origin",
        headers: {
          "Accept": "application/json"
        }
      });
      if (!resp.ok) return;
      const fresh = await resp.json();
      apply(fresh);
      window.dispatchEvent(new CustomEvent("tcs:problems-data", {
        detail: {
          ...fresh,
          fetchedAt: Date.now()
        }
      }));
    } catch (e) {
      console.warn("[tcs] problems fetch failed:", e);
    }
  };
  window.tcsProblemsRefresh = fetchNow;
  window.tcsProblemsFetch = delta => {
    currentFilters = {
      ...currentFilters,
      ...(delta || {})
    };
    return fetchNow();
  };
  window.tcsProblemsGetFilters = () => ({
    ...currentFilters
  });
  setInterval(fetchNow, REFRESH_MS);
})();