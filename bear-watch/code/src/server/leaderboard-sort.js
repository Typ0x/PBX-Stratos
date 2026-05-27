/**
 * wfLeaderboardSort — orders scored decode results for the live
 * leaderboard. Pure: returns a new array, never mutates the input.
 *
 * Order: avg net return per trade (test.mean) descending — the number
 * each row already displays, so the visible order matches the visible
 * figure. Ties break by trade count (more trades = more trustworthy),
 * then pubkey for a deterministic, stable result.
 *
 * Shipped as a sibling dashboard asset: loaded in the browser via a
 * <script> tag (defines window.wfLeaderboardSort) and in node tests via
 * require() (module.exports). No build step.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.wfLeaderboardSort = api.wfLeaderboardSort;
})(typeof window !== 'undefined' ? window : null, function () {
  function wfLeaderboardSort(results) {
    return results.slice().sort(function (a, b) {
      if (b.test.mean !== a.test.mean) return b.test.mean - a.test.mean;
      if (b.test.trips !== a.test.trips) return b.test.trips - a.test.trips;
      return a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0;
    });
  }
  return { wfLeaderboardSort: wfLeaderboardSort };
});
