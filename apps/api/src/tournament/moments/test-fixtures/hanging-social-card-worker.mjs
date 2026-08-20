// A real worker that never replies. The client timeout must terminate it so
// the single-concurrency render queue can continue serving later requests.
setInterval(() => {}, 1_000);
