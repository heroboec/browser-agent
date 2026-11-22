// Settings-page only: one request at a time, bounded session, error backoff.
export function createFastPoller({ poll, onStop = () => {}, schedule = setTimeout, cancel = clearTimeout, now = Date.now }) {
  let active = false, generation = 0, timer, deadline, failures = 0;
  async function step(session) {
    if (!active || session !== generation) return;
    if (now() >= deadline) { stop(); return; }
    try { await poll(); failures = 0; }
    catch { failures = Math.min(failures + 1, 5); }
    if (active && session === generation) {
      timer = schedule(() => { void step(session); }, Math.min(30000, 1000 * 2 ** failures));
    }
  }
  function stop() {
    active = false;
    generation++;
    cancel(timer);
    onStop();
  }
  return {
    start() {
      if (active) return;
      active = true;
      failures = 0;
      deadline = now() + 15 * 60 * 1000;
      void step(++generation);
    },
    stop
  };
}
