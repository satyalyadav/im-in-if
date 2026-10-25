const sweepUrl = new URL(process.env.SCHEDULER_URL ?? "http://localhost:3000/api/maintenance/sweep");
const secret = process.env.SCHEDULER_SECRET;

if (!secret) {
  process.stderr.write("SCHEDULER_SECRET is required.\n");
  process.exitCode = 2;
} else {
  try {
    const healthUrl = new URL("/api/maintenance/health", sweepUrl);
    const response = await fetch(healthUrl, {
      headers: { authorization: `Bearer ${secret}`, accept: "application/json" },
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      process.stderr.write(`The maintenance health endpoint returned HTTP ${response.status}.\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result?.healthy !== true) process.exitCode = 1;
    }
  } catch {
    process.stderr.write("The maintenance health endpoint could not be reached.\n");
    process.exitCode = 1;
  }
}
